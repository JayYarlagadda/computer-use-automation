/**
 * Trace to capability artifact.
 *
 * This is where a run becomes a contract. Everything before it is one model
 * poking at one screen on one afternoon; everything after it is a typed,
 * reviewable capability that executes with no model in the decision loop. If
 * this file does its job badly, the rest of the system is a very careful
 * runtime for a document that was never true.
 *
 * A trace is not an artifact, and the gap between them is the work:
 *
 * - Node ids die with the observation that produced them, so every control has
 *   to be re-expressed as a durable locator (see ./locators.ts).
 * - `/member/100245` is a recording of one lookup; `/member/{memberId}` is a
 *   lookup capability.
 * - The model typed a password. That must become a named secret reference, or
 *   the artifact is a credential in a file.
 * - Exploration is in the trace. A capability that reproduces the model's
 *   wrong turns is slower and more fragile for no benefit.
 *
 * Three rules hold the whole thing together.
 *
 * **Nothing is emitted that was not verified against the recording.** Every
 * locator rung is run through the real replay resolver against the observation
 * the model was looking at, and dropped unless it uniquely resolves to the
 * node that was acted on. Every synthesised checkpoint is evaluated against
 * the observation it describes. Every outcome proposed by the authoring model
 * is checked to make sure it does *not* fire on the success screen -- an
 * outcome that matches a successful run turns every success into "no such
 * member". The compiler can still be wrong about the future; it is not allowed
 * to be wrong about the past.
 *
 * **No concrete value from the run reaches the artifact.** Goal inputs become
 * parameters, credentials become secret references, and any locator text or
 * checkpoint text carrying one of those values is refused rather than quietly
 * baked in. The failure this prevents is the nastiest one available here: an
 * artifact that passes review, replays perfectly for the member it was
 * recorded against, and silently finds nothing for every other member.
 *
 * **The model does not get a vote on behaviour.** Steps, targets, checkpoints
 * and extraction are computed from the trace. A single out-of-loop call
 * (./authoring.ts) proposes names, descriptions and candidate outcomes, and
 * the compiler runs without it. Authoring prose with a model is reviewable;
 * deciding where to click at replay time is not.
 *
 * The result is always passed through `parseArtifact`, so a compile either
 * produces something the replay engine will accept or explains why it could
 * not. There is no third state where a half-valid artifact reaches disk.
 */

import {
  SCHEMA_VERSION,
  canonicalisePath,
  parseArtifact,
  pathOf,
  type AppIdentity,
  type ArtifactIssue,
  type BusinessOutcome,
  type CapabilityArtifact,
  type CapabilityArtifactInput,
  type Checkpoint,
  type OutputSpec,
  type ParamSpec,
  type Step,
  type Transform,
  type ValueSpec,
} from '../artifact/index.js';
import type { Policy, RiskClass } from '../policy/types.js';
import { evaluate } from '../replay/checkpoint.js';
import type { Observation, UiNode } from '../surface/types.js';
import type { AuthoringProposal } from './authoring.js';
import { buildLadder, describeNode, type RungReport } from './locators.js';
import type { GoalInput } from './prompt.js';
import type { DeclaredOutput } from './tools.js';
import type { DiscoveryRun, TraceStep } from './trace.js';

export interface CompileOptions {
  run: DiscoveryRun;
  capability: {
    id: string;
    version?: string;
    /** Overrides anything the authoring model proposed. */
    title?: string;
    description?: string;
  };
  /** What was being driven. Not inferable from a trace, so the caller says. */
  app: AppIdentity;
  /** Used to classify each step's risk and to refuse literals that look secret. */
  policy: Policy;
  /**
   * Secret name -> the value used during discovery. Typed text matching one of
   * these compiles to `{ from: 'secret', ref }`, which is what makes a sign-on
   * flow safe to commit. Values are used for comparison only and are never
   * written anywhere.
   */
  secrets?: Record<string, string>;
  /** Metadata from the one out-of-loop model call. Entirely optional. */
  authoring?: AuthoringProposal;
}

export interface CompileIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** What the compiler did, for the CLI and for `/evidence/`. */
export interface CompileReport {
  stepsExplored: number;
  stepsKept: number;
  dropped: Array<{ index: number; intent: string; why: string }>;
  /** Ladder construction per step, including the rungs that were refused. */
  locators: Array<{ stepId: string; rungs: RungReport[] }>;
  /** Outcomes the authoring model proposed and why any were not accepted. */
  outcomes: Array<{ code: string; accepted: boolean; reason: string }>;
  issues: CompileIssue[];
}

export type CompileResult =
  | { ok: true; artifact: CapabilityArtifact; report: CompileReport; warnings: ArtifactIssue[] }
  | { ok: false; report: CompileReport };

/** Discovery can only produce these; the rest of the vocabulary is replay's. */
const RISK_ORDER: RiskClass[] = ['safe', 'reversible', 'irreversible'];

export function compile(options: CompileOptions): CompileResult {
  const { run, policy } = options;
  const issues: CompileIssue[] = [];
  const error = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  const report: CompileReport = {
    stepsExplored: run.steps.length,
    stepsKept: 0,
    dropped: [],
    locators: [],
    outcomes: [],
    issues,
  };

  if (run.status !== 'succeeded' || !run.success) {
    error(
      '(root)',
      `Only a successful run compiles into a capability. This run ${describeNonSuccess(run)}. ` +
        'The trace and its evidence are still worth keeping; there is just no contract to derive from them.',
    );
    return { ok: false, report };
  }

  const secrets = options.secrets ?? {};
  const inputs = run.inputs;
  const inputValues = Object.fromEntries(inputs.map((i) => [i.name, i.value]));

  // Everything that must never be written into a locator, a checkpoint or a
  // literal: the caller's values and every credential.
  const avoid = [...inputs.map((i) => i.value), ...Object.values(secrets)].filter((v) => v?.trim());

  // ---- steps ---------------------------------------------------------------

  const kept = keepSteps(run, report);
  const usedParams = new Set<string>();
  const steps: Step[] = [];
  const ids = new Set<string>();

  kept.forEach((traceStep, position) => {
    const id = uniqueId(traceStep, position, ids);
    const at = `steps[${position}]`;

    const compiled = compileStep(traceStep, {
      id,
      at,
      avoid,
      inputs,
      inputValues,
      secrets,
      policy,
      usedParams,
      report,
      error,
      warn,
    });

    if (compiled) steps.push(compiled);
  });

  if (!steps.length) {
    error('steps', 'Nothing survived compilation: the run reached its goal without any usable action.');
  }

  // ---- the call signature --------------------------------------------------

  const params = inputs.map((input, i) => {
    if (!usedParams.has(input.name)) {
      warn(
        `inputs[${i}]`,
        `Input "${input.name}" was supplied to the run but never typed into the application. It is ` +
          'declared so the contract stays honest about what the caller passes, but nothing consumes it.',
      );
    }
    return toParamSpec(input, options.authoring);
  });

  const success = run.success;
  const outputs = compileOutputs(success.outputs, success.finalObservation, avoid, error, warn, options);

  // ---- success and outcomes -------------------------------------------------

  const successCheckpoint = compileSuccessCheckpoint(success, avoid, error);
  const outcomes = compileOutcomes(options.authoring, success.finalObservation, avoid, report);

  if (!outcomes.length) {
    warn(
      'outcomes',
      'No business outcomes were declared. Every non-success answer this capability meets will be ' +
        'reported as a failure, which is usually wrong. Add them before approving it.',
    );
  }

  const risk = kept.reduce<RiskClass>(
    (worst, step) => maxRisk(worst, policy.classify(step.action, step.node)),
    'safe',
  );

  report.stepsKept = steps.length;

  if (issues.some((i) => i.severity === 'error')) return { ok: false, report };

  // ---- envelope -------------------------------------------------------------

  const draft: CapabilityArtifactInput = {
    schemaVersion: SCHEMA_VERSION,
    capability: {
      id: options.capability.id,
      version: options.capability.version ?? '1.0.0',
      title: options.capability.title ?? options.authoring?.title ?? defaultTitle(run),
      description:
        options.capability.description ?? options.authoring?.description ?? defaultDescription(run, outputs),
    },
    app: options.app,
    inputs: params,
    outputs,
    outcomes,
    risk,
    // Always a draft. Something a model wrote by poking at a UI does not get to
    // run unattended against bank software because it happened to work once.
    approval: { state: 'draft' },
    steps,
    successCheckpoint,
    recovery: [],
    tenantOverlays: [],
    provenance: {
      // The goal as given to the agent, with this run's values replaced by
      // parameter names. Leaving "look up member 100245" in provenance would
      // put the recorded instance back into a document whose whole job is to
      // not be about that instance.
      goal: scrubInstanceValues(run.goal, inputs, secrets),
      recordedAt: run.finishedAt,
      discoveryRunId: run.runId,
      model: run.model,
      stepsExplored: run.steps.length,
      stepsKept: steps.length,
      ...(run.evidencePath ? { evidencePath: run.evidencePath } : {}),
    },
  };

  const parsed = parseArtifact(draft);
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      issues.push({ path: issue.path, message: issue.message, severity: issue.severity });
    }
    return { ok: false, report };
  }

  return { ok: true, artifact: parsed.artifact, report, warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Which steps survive
// ---------------------------------------------------------------------------

/**
 * Exploration is dropped; the flow is kept.
 *
 * Refused and failed actions go first -- they did not happen, so replaying
 * them would only reproduce the refusal. Then actions that left the screen
 * exactly as they found it: a click on a dead control is a wrong turn the
 * model recovered from, and baking it into the capability makes every future
 * run slower and gives the flow a step whose checkpoint can never mean
 * anything. Type and select are exempt: a password field never exposes its
 * value, so a successful credential entry looks identical afterwards.
 */
function keepSteps(run: DiscoveryRun, report: CompileReport): TraceStep[] {
  const kept: TraceStep[] = [];

  for (const step of run.steps) {
    const drop = (why: string) => report.dropped.push({ index: step.index, intent: step.why, why });

    if (step.refusal) {
      drop(`refused by the safety layer (${step.refusal.code})`);
      continue;
    }
    if (!step.ok) {
      drop(`the action did not succeed: ${step.error ?? 'unknown reason'}`);
      continue;
    }
    // Typing and selecting change field state. The observation often cannot
    // show that -- password values are never captured, and many inputs have
    // no accessible value -- so "the screen looks the same" is not evidence
    // the action accomplished nothing. Dropping those steps is how a sign-on
    // compiles into a flow that never types the password.
    if (step.noChange && step.action.type !== 'type' && step.action.type !== 'select') {
      drop('the screen was unchanged afterwards, so the action accomplished nothing');
      continue;
    }
    kept.push(step);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

interface StepContext {
  id: string;
  at: string;
  avoid: string[];
  inputs: GoalInput[];
  inputValues: Record<string, string>;
  secrets: Record<string, string>;
  policy: Policy;
  usedParams: Set<string>;
  report: CompileReport;
  error: (path: string, message: string) => void;
  warn: (path: string, message: string) => void;
}

function compileStep(traceStep: TraceStep, ctx: StepContext): Step | undefined {
  const { action, node } = traceStep;
  const intent = traceStep.why;

  const target = node ? ladderFor(node, traceStep.observationBefore, ctx) : undefined;
  if (node && !target) return undefined;

  const checkpoint = synthesiseCheckpoint(traceStep, ctx);
  const base = {
    id: ctx.id,
    intent,
    ...(target ? { target } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    recovery: [],
    optional: false,
    timeoutMs: 10_000,
  };

  switch (action.type) {
    case 'click':
      return { ...base, action: { type: 'click' } };

    case 'press':
      return { ...base, action: { type: 'press', key: action.key } };

    case 'type': {
      const value = valueSpecFor(action.text, node, `${ctx.at}.action.value`, ctx);
      if (!value) return undefined;
      return { ...base, action: { type: 'type', value } };
    }

    case 'select': {
      const option = valueSpecFor(action.option, node, `${ctx.at}.action.option`, ctx);
      if (!option) return undefined;
      return { ...base, action: { type: 'select', option } };
    }

    case 'navigate': {
      const location = locationFor(action.location, `${ctx.at}.action.location`, ctx);
      if (!location) return undefined;
      // A target is meaningless for navigation and the validator warns about it.
      const { target: _unused, ...rest } = base;
      return { ...rest, action: { type: 'navigate', location } };
    }

    default:
      ctx.error(`${ctx.at}.action`, `Discovery produced a "${action.type}" action, which has no compiled form.`);
      return undefined;
  }
}

function ladderFor(node: UiNode, observation: Observation, ctx: StepContext) {
  const ladder = buildLadder(node, observation, { avoid: ctx.avoid });
  ctx.report.locators.push({ stepId: ctx.id, rungs: ladder.rungs });

  if (!ladder.target) {
    ctx.error(
      `${ctx.at}.target`,
      `No durable way to address ${describeNode(node)} was found. Every candidate either failed to ` +
        'resolve on the recorded screen, matched more than one control, or would have had to quote a ' +
        'value from this particular run. Refusing to emit a locator that was never verified.',
    );
    return undefined;
  }

  if (ladder.target.strategies.length === 1) {
    ctx.warn(
      `${ctx.at}.target`,
      `${describeNode(node)} has a single locator strategy, so there is no fallback if the screen ` +
        'changes. That is sometimes correct -- a wrong match is worse than none -- but it is worth a look.',
    );
  }

  return ladder.target;
}

// ---------------------------------------------------------------------------
// Where a value comes from
// ---------------------------------------------------------------------------

/**
 * The most important classification in the compiler.
 *
 * A credential becomes a named reference resolved at replay time, so nothing
 * secret is ever written down. A value the caller supplied becomes a
 * parameter, which is what turns one recorded lookup into a lookup capability.
 * Anything else is a literal -- but only after checking it is not something
 * that merely *looks* like a credential, because a literal in a committed
 * artifact is a literal in a public repository.
 */
function valueSpecFor(
  text: string,
  node: UiNode | undefined,
  path: string,
  ctx: StepContext,
): ValueSpec | undefined {
  const secretRef = Object.entries(ctx.secrets).find(([, value]) => value === text)?.[0];
  if (secretRef) return { from: 'secret', ref: secretRef };

  const param = ctx.inputs.find((input) => input.value === text);
  if (param) {
    ctx.usedParams.add(param.name);
    return { from: 'param', param: param.name };
  }

  if (node?.sensitive) {
    ctx.error(
      path,
      'The run typed into a field the policy layer marks sensitive, with text that is not a known ' +
        'secret. Compiling it would write a credential into the artifact. Pass the value in ' +
        '`secrets` so it compiles to a named reference instead.',
    );
    return undefined;
  }

  if (ctx.policy.redact(text) !== text) {
    ctx.error(
      path,
      'The text typed here matches a redaction pattern, so it is regulated or secret. It cannot be ' +
        'stored as a literal. Declare it as a goal input or a named secret.',
    );
    return undefined;
  }

  return { from: 'literal', value: text };
}

/**
 * Concrete path to template.
 *
 * `/member/100245` recorded against a goal carrying `memberId=100245` is
 * `/member/{memberId}`. Whole-segment matching only -- see `canonicalisePath`,
 * which refuses to rewrite `/branch/100245-north` into something that reads
 * plausibly and is wrong.
 */
function locationFor(location: string, path: string, ctx: StepContext) {
  const concrete = pathOf(location);

  for (const [name, value] of Object.entries(ctx.secrets)) {
    if (value && concrete.includes(value)) {
      ctx.error(path, `The recorded path contains the value of secret "${name}". Refusing to compile it.`);
      return undefined;
    }
  }

  const pathTemplate = canonicalisePath(concrete, ctx.inputValues);

  const params: Record<string, ValueSpec> = {};
  for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    ctx.usedParams.add(name);
    params[name] = { from: 'param', param: name };
  }

  return { pathTemplate, params };
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * What this step should have achieved, stated so replay can check it.
 *
 * Two things are asserted where they are available: the screen we landed on
 * (as a path template, so it stays true for every member) and its title. Both
 * are evaluated against the recorded after-observation before being emitted --
 * a checkpoint that does not hold on the screen it was derived from is a bug,
 * not a stricter assertion.
 *
 * Nothing is invented where nothing changed. A step with no checkpoint draws a
 * warning from the validator, which is the honest outcome: better a reviewer
 * sees the gap than reads an assertion that restates the screen the step
 * started on.
 *
 * Note what is *not* here: the declared business outcomes are not folded into
 * every checkpoint as alternatives. Replay checks outcomes before it checks a
 * step's checkpoint, so a legitimate "no such member" is reported as an answer
 * rather than failing the assertion on the way past.
 */
function synthesiseCheckpoint(traceStep: TraceStep, ctx: StepContext): Checkpoint | undefined {
  const after = traceStep.observationAfter;
  if (!after) return undefined;

  const before = traceStep.observationBefore;
  const parts: Checkpoint[] = [];

  const beforePath = canonicalisePath(pathOf(before.location), ctx.inputValues);
  const afterPath = canonicalisePath(pathOf(after.location), ctx.inputValues);
  if (afterPath !== beforePath) parts.push({ kind: 'location-matches', pathTemplate: afterPath });

  const title = after.title.trim();
  if (title && title !== before.title.trim() && !carriesInstanceValue(title, ctx.avoid)) {
    parts.push({ kind: 'text-present', text: title, match: 'contains' });
  }

  if (!parts.length) return undefined;

  const checkpoint: Checkpoint = parts.length === 1 ? parts[0]! : { kind: 'all', of: parts };

  // The verification that makes this safe to emit at all.
  if (!evaluate(checkpoint, { observation: after, path: pathOf(after.location) })) return undefined;

  return checkpoint;
}

/**
 * The claim the caller actually cares about: not "the last click landed" but
 * "the capability did what it was asked to do".
 *
 * The model quotes text from the success screen and the tool layer has already
 * confirmed it appears there. What is checked here is the other half, which
 * the model is in no position to judge: that the quoted text is not the answer
 * for this particular run. "Member Detail" proves success for everyone;
 * "$4,182.55" proves it for exactly one member and fails silently for the rest.
 */
function compileSuccessCheckpoint(
  success: { successText: string; finalObservation: Observation },
  avoid: string[],
  error: (path: string, message: string) => void,
): Checkpoint {
  const text = success.successText.trim();
  const fallback: Checkpoint = { kind: 'text-present', text, match: 'contains' };

  if (carriesInstanceValue(text, avoid)) {
    error(
      'successCheckpoint',
      `The run proved success by quoting "${text}", which contains a value from this run's inputs. ` +
        'As a success condition that only holds for the run it was recorded from. Re-run discovery, ' +
        'or set the success condition by hand.',
    );
    return fallback;
  }

  if (!evaluate(fallback, {
    observation: success.finalObservation,
    path: pathOf(success.finalObservation.location),
  })) {
    error(
      'successCheckpoint',
      `"${text}" does not hold against the recorded success screen, so it cannot be the success condition.`,
    );
  }

  return fallback;
}

/**
 * Outcomes proposed by the authoring model, each subjected to the one check
 * that matters.
 *
 * An outcome whose detection text also appears on the success screen is worse
 * than no outcome at all: replay tests outcomes first, so every successful run
 * would be reported as "no such member" -- a wrong answer delivered
 * confidently, with a plausible code, to an agent that will act on it. Any
 * proposal that fires on the recorded success is dropped.
 */
function compileOutcomes(
  authoring: AuthoringProposal | undefined,
  successObservation: Observation,
  avoid: string[],
  report: CompileReport,
): BusinessOutcome[] {
  if (!authoring?.outcomes.length) return [];

  const ctx = {
    observation: successObservation,
    path: pathOf(successObservation.location),
  };

  const accepted: BusinessOutcome[] = [];
  const seen = new Set<string>();

  for (const proposal of authoring.outcomes) {
    const note = (reason: string) =>
      report.outcomes.push({ code: proposal.code, accepted: false, reason });

    if (seen.has(proposal.code)) {
      note('duplicate code');
      continue;
    }

    const detect: Checkpoint = { kind: 'text-present', text: proposal.detectText, match: 'contains' };

    if (carriesInstanceValue(proposal.detectText, avoid)) {
      note('its detection text quotes a value from this run, so it would only ever match this run');
      continue;
    }
    if (evaluate(detect, ctx)) {
      note(
        'its detection text is present on the success screen, so it would report every successful ' +
          'run as this outcome',
      );
      continue;
    }

    seen.add(proposal.code);
    accepted.push({
      code: proposal.code,
      title: proposal.title,
      description: proposal.description,
      detect,
      terminal: true,
      outputs: [],
    });
    report.outcomes.push({ code: proposal.code, accepted: true, reason: '' });
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * The values the caller gets back.
 *
 * Extraction targets are built with ordinal strategies disabled. For an action
 * a wrong ordinal usually fails loudly -- the click does nothing and the
 * checkpoint catches it. For a read it returns whatever sits in that position,
 * and a confidently wrong balance handed to an agent that will act on it is
 * the failure mode this system exists to prevent. A lookup that fails is
 * recoverable; a lookup that lies is not.
 */
function compileOutputs(
  declared: DeclaredOutput[],
  observation: Observation,
  avoid: string[],
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
  options: CompileOptions,
): OutputSpec[] {
  const byId = new Map(observation.nodes.map((node) => [node.nodeId, node]));
  const outputs: OutputSpec[] = [];

  declared.forEach((output, i) => {
    const at = `outputs[${i}]`;
    const node = byId.get(output.nodeId);

    if (!node) {
      error(at, `Output "${output.name}" points at node "${output.nodeId}", which is not on the success screen.`);
      return;
    }
    if (node.sensitive) {
      error(
        at,
        `Output "${output.name}" reads a control the policy layer marks sensitive. A capability never ` +
          'returns a credential or a regulated value it was told not to capture.',
      );
      return;
    }

    const ladder = buildLadder(node, observation, { avoid, purpose: 'extraction' });

    if (!ladder.target) {
      error(
        at,
        `Output "${output.name}" cannot be addressed durably: ${describeNode(node)} has no verified ` +
          'locator that does not depend on position. Nothing is emitted rather than an extraction ' +
          'rule that would return whatever happens to sit there.',
      );
      return;
    }

    if (ladder.target.strategies.length === 1) {
      warn(at, `Output "${output.name}" has a single locator strategy and no fallback.`);
    }

    outputs.push({
      name: output.name,
      type: output.type,
      description:
        options.authoring?.outputs.find((o) => o.name === output.name)?.description ?? output.description,
      sensitivity: output.sensitivity,
      required: true,
      extract: {
        kind: 'node-text',
        target: ladder.target,
        transforms: transformsFor(output.type),
      },
    });
  });

  return outputs;
}

function transformsFor(type: OutputSpec['type']): Transform[] {
  // Currency is carried as a decimal string, so the rendered "$4,182.55" has to
  // lose its formatting or every caller re-implements the same parse.
  return type === 'currency' ? ['trim', 'strip-currency'] : ['trim'];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A goal input becomes a declared parameter.
 *
 * The shape constraint is inferred from the recorded value and is worth having
 * for a reason beyond tidiness: a validated parameter fails as *input*, before
 * the browser opens, instead of surfacing three steps later as the
 * application's own complaint about a malformed member number.
 *
 * No example is taken from the run. The schema asks for a fabricated one, and
 * the value discovery used is a real value from wherever the goal came from.
 * An example is only carried when the authoring model made one up and the
 * parameter is not regulated.
 */
function toParamSpec(input: GoalInput, authoring: AuthoringProposal | undefined): ParamSpec {
  const proposed = authoring?.inputs.find((i) => i.name === input.name);
  const value = input.value;

  const spec: ParamSpec = {
    name: input.name,
    type: 'string',
    description:
      proposed?.description ?? input.description ?? `Value supplied by the caller for "${input.name}".`,
    required: true,
    sensitivity: 'internal',
  };

  if (/^\d+$/.test(value)) {
    spec.pattern = `^\\d{${value.length}}$`;
    spec.minLength = value.length;
    spec.maxLength = value.length;
  }

  const example = proposed?.example?.trim();
  if (example && example !== value) spec.example = example;

  return spec;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function carriesInstanceValue(text: string, avoid: string[]): boolean {
  return avoid.some((value) => text.includes(value));
}

function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/** Readable, stable, and unique: `3-run-the-member-search`. */
function uniqueId(step: TraceStep, position: number, taken: Set<string>): string {
  const slug =
    step.why
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-') || step.action.type;

  let id = `${position + 1}-${slug}`.slice(0, 60).replace(/-+$/, '');
  while (taken.has(id)) id = `${id}-x`;
  taken.add(id);
  return id;
}

function defaultTitle(run: DiscoveryRun): string {
  const goal = scrubInstanceValues(run.goal, run.inputs).trim().replace(/\.$/, '');
  return goal.length <= 90 ? goal : `${goal.slice(0, 87)}...`;
}

function defaultDescription(run: DiscoveryRun, outputs: OutputSpec[]): string {
  const returns = outputs.length
    ? `Returns ${outputs.map((o) => o.name).join(', ')}.`
    : 'Returns no data.';
  const summary = scrubInstanceValues(run.success?.summary ?? run.goal, run.inputs);
  return `${summary} ${returns}`;
}

/**
 * Replaces recorded values with `{name}` so a goal, a title or a summary
 * cannot smuggle the instance back into the artifact as prose.
 *
 * Longer values first, so replacing `100245` cannot leave a hole in a longer
 * token that happened to contain it.
 */
function scrubInstanceValues(
  text: string,
  inputs: GoalInput[],
  secrets: Record<string, string> = {},
): string {
  const replacements: Array<{ token: string; value: string }> = [
    ...inputs.filter((i) => i.value.trim()).map((i) => ({ token: `{${i.name}}`, value: i.value })),
    ...Object.entries(secrets)
      .filter(([, value]) => value.trim())
      .map(([name, value]) => ({ token: `{${name}}`, value })),
  ].sort((a, b) => b.value.length - a.value.length);

  return replacements.reduce((out, { token, value }) => out.split(value).join(token), text);
}

function describeNonSuccess(run: DiscoveryRun): string {
  switch (run.status) {
    case 'business-outcome':
      return `ended in the business outcome ${run.outcome?.code ?? '(unknown)'}`;
    case 'escalated':
      return `was escalated to a human (${run.escalation?.reason ?? 'no reason recorded'})`;
    case 'abandoned':
      return `was abandoned (${run.abandonment?.reason ?? 'no reason recorded'})`;
    case 'failed':
      return `failed with ${run.failure?.code ?? 'an unknown failure'}`;
    default:
      return `ended with status "${run.status}"`;
  }
}
