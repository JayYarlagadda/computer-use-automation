/**
 * Deterministic replay: the production execution path.
 *
 * This is the function an AI agent's tool call ultimately reaches. There is no
 * model in it, and structurally there cannot be -- nothing in `src/replay/`
 * imports `src/llm/`, so "the LLM is a component of discovery only" is enforced
 * by the module graph rather than by intention.
 *
 * The order of operations is the design. Everything that can be checked without
 * touching the application is checked first:
 *
 *   validate artifact -> bind tenant -> check approval -> validate inputs
 *   -> resolve secrets -> only then open the surface
 *
 * A capability that is not approved, or a member number with five digits, fails
 * before a browser exists. Discovering that four steps into a signed-on session
 * is slower, noisier, and reports the wrong thing: a five-digit member number
 * rejected by the application looks like a business outcome, when really the
 * call was malformed.
 *
 * After each step the screen is examined in a fixed order, and that order also
 * matters: declared business outcomes are checked *before* the step's
 * checkpoint. "No member found" is an answer, and a checkpoint that has not
 * anticipated it would otherwise report a working capability as broken.
 */

import { randomUUID } from 'node:crypto';
import {
  bindTenant,
  digest,
  expandPath,
  parseArtifact,
  pathOf,
  type BusinessOutcome,
  type CapabilityArtifact,
  type Checkpoint,
  type RecoveryRule,
  type Step,
  type ValueSpec,
} from '../artifact/index.js';
import type {
  Escalation,
  Failure,
  FailureCode,
  Outputs,
  RecoveryReport,
  ReplayResult,
  Resolution,
  StepReport,
} from '../artifact/result.js';
import { NULL_SINK, type EvidenceSink } from '../evidence/types.js';
import { resumes, type Disposition } from '../hitl/types.js';
import type { Action, Observation, Surface } from '../surface/types.js';
import { describe as describeCheckpoint, evaluate, explain, summariseScreen } from './checkpoint.js';
import { extractOutputs, type ExtractionContext } from './extract.js';
import { bindInputs } from './inputs.js';
import { describeTarget, resolveTarget } from './resolve.js';

/** Resolves a named secret. Never returns it to the caller of replay. */
export type SecretResolver = (ref: string) => string | undefined;

export interface ReplayOptions {
  /** Unvalidated on purpose: replay validates, so a bad artifact fails here. */
  artifact: unknown;
  inputs: Record<string, unknown>;
  tenantId: string;
  /** Origin the path templates are expanded against. Supplied per tenant. */
  baseUrl: string;
  mode: 'unattended' | 'attended';
  /** Injected, so replay is surface-agnostic. The whole point of D1. */
  surface: Surface;
  secrets?: SecretResolver;
  /** The tenant's actual product version, if known. Used for drift reporting. */
  productVersion?: string;
  evidence?: EvidenceSink;
  /** Handles `run-capability` recovery. Absent means that recovery is skipped. */
  runCapability?: (capabilityId: string, version?: string) => Promise<boolean>;
  /**
   * Hands the run to a person and waits for them.
   *
   * Absent, or returning no disposition, and escalation is terminal exactly as
   * it was before there was anywhere to escalate *to*: the result carries the
   * ids and the run stops. Wired to a `SessionBroker`, the same hook blocks
   * until the operator hands the session back, and the run continues from
   * where it stopped.
   */
  escalate?: (request: EscalationRequest) => Promise<EscalationHandling>;
  /**
   * How many times one run may stop for a person before it gives up.
   *
   * A capability that needs a human at every step is not automation, and a
   * resume path with no budget is a loop that parks a person in front of the
   * same screen forever. Defaults to 2.
   */
  maxEscalations?: number;
  runId?: string;
  /** Overall budget. A run that cannot finish should stop, not hang. */
  timeoutMs?: number;
}

export interface EscalationRequest {
  runId: string;
  capabilityId: string;
  reason: Escalation['reason'];
  message: string;
  stepId?: string;
  /** What the stalled step was trying to achieve, so a person can finish it. */
  intent?: string;
  observation?: Observation;
  screenshotPath?: string;
  observationPath?: string;
}

/** What the escalation handler reports back once a person has dealt with it. */
export interface EscalationHandling {
  sessionId: string;
  interventionId: string;
  /** Absent means nobody resolved it and the run stops. */
  disposition?: Disposition;
  operator?: string;
  note?: string;
}

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const runId = options.runId ?? randomUUID();
  const evidence = options.evidence ?? NULL_SINK;
  const startedAt = new Date();
  const deadline = startedAt.getTime() + (options.timeoutMs ?? 120_000);
  const steps: StepReport[] = [];

  // ---- pre-flight, in cost order ------------------------------------------

  const parsed = parseArtifact(options.artifact);
  if (!parsed.ok) {
    return preflightFailure(runId, startedAt, evidence, options, {
      code: 'ARTIFACT_INVALID',
      message: parsed.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.path}: ${i.message}`)
        .join('; '),
    });
  }

  const bound = bindTenant(parsed.artifact, options.tenantId, {
    ...(options.productVersion ? { productVersion: options.productVersion } : {}),
  });
  const artifact = bound.artifact;

  await evidence.event({
    at: startedAt.toISOString(),
    kind: 'replay.start',
    runId,
    capabilityId: artifact.capability.id,
    capabilityVersion: artifact.capability.version,
    artifactDigest: digest(artifact),
    tenantId: options.tenantId,
    mode: options.mode,
    // Input *names* only. Values are recorded per-step, redacted by sensitivity.
    inputNames: Object.keys(options.inputs),
    versionDrift: bound.versionDrift ?? null,
  });

  const context = (): ReplayContext => ({
    runId,
    artifact,
    options,
    evidence,
    startedAt,
    steps,
    versionDrift: bound.versionDrift,
  });

  if (options.mode === 'unattended' && artifact.approval.state !== 'approved') {
    // The gate that makes the draft/approved distinction mean something. A
    // freshly discovered artifact is a document a model wrote by poking at a
    // UI; letting it run unsupervised against bank software because it worked
    // once is not a defensible default.
    return failed(context(), {
      code: 'NOT_APPROVED',
      message:
        `Capability is in state "${artifact.approval.state}". ` +
        `Unattended replay requires an approved capability.`,
    });
  }

  const inputs = bindInputs(artifact.inputs, options.inputs);
  if (!inputs.ok) {
    return failed(context(), {
      code: 'INPUT_INVALID',
      message: inputs.problems.map((p) => `${p.param}: ${p.message}`).join('; '),
    });
  }

  const resolveValue = valueResolver(inputs.values, options.secrets);
  const missingSecret = firstMissingSecret(artifact, resolveValue);
  if (missingSecret) {
    return failed(context(), {
      code: 'INPUT_INVALID',
      message: `Secret "${missingSecret}" is not available in this environment.`,
    });
  }

  // ---- the flow ------------------------------------------------------------

  const pathTemplates = collectPathTemplates(artifact);

  // Restarts are budgeted. A recovery that resumes earlier in the flow can, if
  // the underlying condition keeps recurring, loop forever -- and a run that
  // never terminates is worse than one that fails, because nothing surfaces.
  let restartsLeft = 2;
  let escalationsLeft = options.maxEscalations ?? 2;

  for (let i = 0; i < artifact.steps.length; i++) {
    const step = artifact.steps[i]!;

    if (Date.now() > deadline) {
      return failed(context(), { code: 'TIMEOUT', message: 'Run budget exhausted.', stepId: step.id });
    }

    const outcome = await runStep(step, {
      ctx: context(),
      resolveValue,
      deadline,
    });

    steps.push(outcome.report);

    if (outcome.kind === 'business-outcome') {
      return await businessOutcome(context(), outcome.outcome, outcome.observation, pathTemplates);
    }
    if (outcome.kind === 'escalate') {
      const handled = await handleEscalation(context(), outcome, step, escalationsLeft);
      if (handled.kind === 'stop') return handled.result;

      escalationsLeft -= 1;

      // Re-run the step. -1 because the loop increment puts us back on it.
      if (handled.kind === 'retry') {
        i -= 1;
        continue;
      }

      // Verified: a person did the work and the step's own condition now
      // holds, so the flow carries on from the next step.
      continue;
    }
    if (outcome.kind === 'failed') {
      return failed(context(), outcome.failure);
    }
    if (outcome.kind === 'restart') {
      const target = artifact.steps.findIndex((s) => s.id === outcome.fromStepId);
      if (target < 0 || restartsLeft-- <= 0) {
        return failed(context(), {
          code: 'SESSION_LOST',
          message:
            target < 0
              ? `Recovery asked to restart from "${outcome.fromStepId}", which is not a step of this capability.`
              : 'Recovery restarted the flow repeatedly without making progress.',
          stepId: step.id,
        });
      }
      // -1 because the loop increment moves us onto the restart step itself.
      i = target - 1;
    }
  }

  // ---- success condition and outputs ---------------------------------------

  const finalObservation = await observe(options.surface, true);
  const checkCtx = { observation: finalObservation, path: pathOf(finalObservation.location) };

  const declared = detectOutcome(artifact.outcomes, checkCtx);
  if (declared) {
    return await businessOutcome(context(), declared, finalObservation, pathTemplates);
  }

  if (!evaluate(artifact.successCheckpoint, checkCtx)) {
    const shot = await capture(evidence, options.surface, 'success-checkpoint-failed', finalObservation);
    return failed(context(), {
      code: 'CHECKPOINT_FAILED',
      message: 'All steps ran but the capability did not reach its success condition.',
      expected: explain(artifact.successCheckpoint, checkCtx),
      observed: summariseScreen(checkCtx),
      ...shot,
    });
  }

  const extraction: ExtractionContext = {
    observation: finalObservation,
    path: checkCtx.path,
    pathTemplates,
  };
  const { outputs, missing } = extractOutputs(artifact.outputs, extraction);

  if (missing.length) {
    const shot = await capture(evidence, options.surface, 'extraction-failed', finalObservation);
    return failed(context(), {
      code: 'EXTRACTION_FAILED',
      message: `Reached the success condition but could not produce: ${missing
        .map((m) => `${m.name} (${m.reason})`)
        .join('; ')}`,
      ...shot,
    });
  }

  await evidence.event({
    at: new Date().toISOString(),
    kind: 'replay.success',
    runId,
    outputs: redactOutputs(outputs),
  });

  return { ...envelope(context()), status: 'success', outputs };
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

interface ReplayContext {
  runId: string;
  artifact: CapabilityArtifact;
  options: ReplayOptions;
  evidence: EvidenceSink;
  startedAt: Date;
  steps: StepReport[];
  versionDrift?: { recordedAgainst: string; bindingTo: string };
}

type StepOutcome =
  | { kind: 'ok'; report: StepReport; observation: Observation }
  | { kind: 'business-outcome'; report: StepReport; outcome: BusinessOutcome; observation: Observation }
  | {
      kind: 'escalate';
      report: StepReport;
      reason: Escalation['reason'];
      message: string;
      observation: Observation;
      /**
       * What to do if a person fixes it and hands back.
       *
       * `retry` means the step never ran -- its control could not be found, and
       * clearing the blockage is all that was needed, so the automation does
       * the step itself. `verify` means the action already happened, or the
       * person performed it in our place, so the only honest thing left is to
       * check the step's condition and carry on.
       */
      resume: 'retry' | 'verify';
    }
  | { kind: 'restart'; report: StepReport; fromStepId: string }
  | { kind: 'failed'; report: StepReport; failure: Failure };

/**
 * Runs whichever recovery rules match the current screen, until `probe` says
 * the step can proceed.
 *
 * Shared by both places a step can get stuck -- target resolution and
 * checkpoint evaluation -- because the same conditions cause both. What
 * differs is only the test for "is it fixed now", which is why that is a
 * parameter.
 */
interface RecoveryAttempt {
  fixed: boolean;
  observation: Observation;
  escalate?: string;
  restartFrom?: string;
}

async function attemptRecovery(
  rules: RecoveryRule[],
  step: Step,
  env: { ctx: ReplayContext; resolveValue: (spec: ValueSpec) => string | undefined; deadline: number },
  originalAction: Action | undefined,
  report: StepReport,
  probe: (observation: Observation) => boolean,
  startObservation: Observation,
): Promise<RecoveryAttempt> {
  const { ctx } = env;
  let observation = startObservation;

  for (const rule of rules) {
    let ctxNow = { observation, path: pathOf(observation.location) };
    if (!evaluate(rule.when, ctxNow)) continue;

    for (let attempt = 1; attempt <= rule.maxAttempts; attempt++) {
      if (Date.now() > env.deadline) break;

      const applied = await applyRecovery(rule, step, env, originalAction);

      if (applied.escalate) {
        report.recoveries.push(recoveryEntry(rule, attempt, false));
        return { fixed: false, observation, escalate: applied.escalate };
      }

      observation = await observe(ctx.options.surface, false);
      ctxNow = { observation, path: pathOf(observation.location) };

      if (rule.restartFrom) {
        // The recovery worked but reset state earlier in the flow. Do not probe
        // -- the step legitimately cannot proceed from here, and the artifact
        // says where to resume instead.
        report.recoveries.push(recoveryEntry(rule, attempt, true));
        await ctx.evidence.event({
          at: new Date().toISOString(),
          kind: 'step.restart',
          runId: ctx.runId,
          stepId: step.id,
          ruleId: rule.id,
          restartFrom: rule.restartFrom,
        });
        return { fixed: false, observation, restartFrom: rule.restartFrom };
      }

      const fixed = probe(observation);
      report.recoveries.push(recoveryEntry(rule, attempt, fixed));

      await ctx.evidence.event({
        at: new Date().toISOString(),
        kind: 'step.recovery',
        runId: ctx.runId,
        stepId: step.id,
        ruleId: rule.id,
        attempt,
        succeeded: fixed,
      });

      if (fixed) return { fixed: true, observation };
    }
  }

  return { fixed: false, observation };
}

function recoveryEntry(rule: RecoveryRule, attempt: number, succeeded: boolean): RecoveryReport {
  return {
    ruleId: rule.id,
    description: rule.description,
    action: rule.then.kind,
    attempt,
    succeeded,
  };
}

async function runStep(
  step: Step,
  env: { ctx: ReplayContext; resolveValue: (spec: ValueSpec) => string | undefined; deadline: number },
): Promise<StepOutcome> {
  const { ctx, resolveValue } = env;
  const { options, evidence } = ctx;
  const startedAt = new Date();

  const report: StepReport = {
    stepId: step.id,
    intent: step.intent,
    status: 'ok',
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    recoveries: [],
  };
  const finish = <T extends StepOutcome>(outcome: T): T => {
    report.durationMs = Date.now() - startedAt.getTime();
    return outcome;
  };

  let observation = await observe(options.surface, false);
  let resolution: Resolution | undefined;
  let action: Action;
  const rules = [...step.recovery, ...ctx.artifact.recovery];

  // ---- build the concrete action from the abstract step --------------------

  if (step.target) {
    const target = step.target;
    let resolved = resolveTarget(target, observation);

    if (!resolved.ok && !step.optional) {
      // Before failing: a missing control is how a surprise interstitial, an
      // expired session or an error screen actually presents itself. Give the
      // declared recovery rules a chance at it.
      const recovered = await attemptRecovery(
        rules,
        step,
        env,
        undefined,
        report,
        (obs) => resolveTarget(target, obs).ok,
        observation,
      );
      observation = recovered.observation;

      if (recovered.escalate) {
        report.status = 'failed';
        return finish({
          kind: 'escalate',
          report,
          reason: 'RECOVERY_EXHAUSTED',
          message: recovered.escalate,
          observation,
          // The action never happened -- we could not even find its control.
          // Once a person has cleared whatever was in the way, the step is
          // still ours to perform.
          resume: 'retry',
        });
      }
      if (recovered.restartFrom) {
        report.status = 'recovered';
        return finish({ kind: 'restart', report, fromStepId: recovered.restartFrom });
      }
      if (recovered.fixed) {
        report.status = 'recovered';
        resolved = resolveTarget(target, observation);
      }
    }

    if (!resolved.ok) {
      if (step.optional) {
        // An optional step whose control is absent is the tenant-configured
        // case: institution A shows no post-sign-on notice, so there is nothing
        // to dismiss and nothing has gone wrong.
        report.status = 'skipped';
        await evidence.event({
          at: new Date().toISOString(),
          kind: 'step.skipped',
          runId: ctx.runId,
          stepId: step.id,
          reason: resolved.message,
        });
        return finish({ kind: 'ok', report, observation });
      }

      const checkCtxNow = { observation, path: pathOf(observation.location) };
      report.status = 'failed';
      report.expected = describeTarget(target);
      report.observed = resolved.message;
      const shot = await capture(evidence, options.surface, `${step.id}-target`, observation);
      Object.assign(report, shot);
      return finish({
        kind: 'failed',
        report,
        failure: {
          // The control was missing *because* the host errored or the session
          // dropped. Reporting TARGET_NOT_FOUND there sends whoever triages it
          // to the artifact when the problem is the application.
          code: classifyScreen(observation) ?? resolved.code,
          message: resolved.message,
          stepId: step.id,
          expected: describeTarget(target),
          observed: summariseScreen(checkCtxNow),
          ...shot,
        },
      });
    }

    resolution = resolved.resolution;
    report.resolution = resolution;
    action = toAction(step, resolved.node.nodeId, resolveValue, options.baseUrl);
  } else {
    action = toAction(step, undefined, resolveValue, options.baseUrl);
  }

  // ---- act ------------------------------------------------------------------

  await evidence.event({
    at: new Date().toISOString(),
    kind: 'step.act',
    runId: ctx.runId,
    stepId: step.id,
    intent: step.intent,
    action: describeAction(action, step),
    resolution: resolution ?? null,
  });

  const result = await options.surface.act(action);

  if (result.refusal?.kind === 'approval-required') {
    // The declared-irreversible path. Same primitive as "stuck", by design:
    // there is one way for this system to stop and ask a person.
    report.status = 'failed';
    return finish({
      kind: 'escalate',
      report,
      reason: 'APPROVAL_REQUIRED',
      message: result.refusal.reason,
      observation,
      // An irreversible step is performed by the person who authorised it, in
      // the live session. There is no path back here that lets the automation
      // do it instead, which is the point -- so all that remains is to check
      // that what they did had the effect the step declared.
      resume: 'verify',
    });
  }

  if (!result.ok) {
    const code: FailureCode = result.refusal ? 'POLICY_DENIED' : 'ACTION_FAILED';
    report.status = 'failed';
    report.observed = result.error ?? 'action failed';
    const shot = await capture(evidence, options.surface, `${step.id}-action`, observation);
    Object.assign(report, shot);
    return finish({
      kind: 'failed',
      report,
      failure: {
        code,
        message: result.error ?? 'The surface refused to perform the action.',
        stepId: step.id,
        ...shot,
      },
    });
  }

  // ---- look at what happened ------------------------------------------------

  observation = await observe(options.surface, false);
  let checkCtx = { observation, path: pathOf(observation.location) };

  // Business outcomes first. A declared outcome is an answer, and checking the
  // step's checkpoint ahead of it would report a working capability as broken.
  const outcome = detectOutcome(ctx.artifact.outcomes, checkCtx);
  if (outcome) {
    report.status = 'ok';
    return finish({ kind: 'business-outcome', report, outcome, observation });
  }

  if (!step.checkpoint) return finish({ kind: 'ok', report, observation });
  if (evaluate(step.checkpoint, checkCtx)) return finish({ kind: 'ok', report, observation });

  // ---- recovery --------------------------------------------------------------

  const checkpoint = step.checkpoint;
  const recovered = await attemptRecovery(
    rules,
    step,
    env,
    action,
    report,
    (obs) => evaluate(checkpoint, { observation: obs, path: pathOf(obs.location) }),
    observation,
  );
  observation = recovered.observation;
  checkCtx = { observation, path: pathOf(observation.location) };

  if (recovered.escalate) {
    report.status = 'failed';
    return finish({
      kind: 'escalate',
      report,
      reason: 'RECOVERY_EXHAUSTED',
      message: recovered.escalate,
      observation,
      // The action was performed and the screen is not what the artifact
      // expected. Repeating it could double a submission, so a person puts the
      // session right and we assert the condition rather than acting again.
      resume: 'verify',
    });
  }
  if (recovered.restartFrom) {
    report.status = 'recovered';
    return finish({ kind: 'restart', report, fromStepId: recovered.restartFrom });
  }

  // A recovery can land on a declared outcome rather than on success: dismissing
  // an interstitial can reveal "no such member" underneath it.
  const recoveredOutcome = detectOutcome(ctx.artifact.outcomes, checkCtx);
  if (recoveredOutcome) {
    report.status = 'recovered';
    return finish({ kind: 'business-outcome', report, outcome: recoveredOutcome, observation });
  }

  if (recovered.fixed) {
    report.status = 'recovered';
    return finish({ kind: 'ok', report, observation });
  }

  // ---- out of options --------------------------------------------------------

  report.status = 'failed';
  report.expected = explain(step.checkpoint, checkCtx);
  report.observed = summariseScreen(checkCtx);
  const shot = await capture(ctx.evidence, options.surface, `${step.id}-checkpoint`, observation);
  Object.assign(report, shot);

  return finish({
    kind: 'failed',
    report,
    failure: {
      code: classifyScreen(checkCtx.observation) ?? 'CHECKPOINT_FAILED',
      message: `Step "${step.id}" (${step.intent}) did not reach its expected state.`,
      stepId: step.id,
      expected: describeCheckpoint(step.checkpoint),
      observed: summariseScreen(checkCtx),
      ...shot,
    },
  });
}

async function applyRecovery(
  rule: RecoveryRule,
  step: Step,
  env: { ctx: ReplayContext; resolveValue: (spec: ValueSpec) => string | undefined; deadline: number },
  originalAction: Action | undefined,
): Promise<{ escalate?: string }> {
  const { options } = env.ctx;

  switch (rule.then.kind) {
    case 'wait':
      await delay(rule.then.ms);
      return {};

    case 'retry-step':
      await delay(rule.then.delayMs);
      if (originalAction) await options.surface.act(await refreshAction(step, originalAction, env));
      return {};

    case 'click': {
      const observation = await observe(options.surface, false);
      const resolved = resolveTarget(rule.then.target, observation);
      if (!resolved.ok) return {};
      await options.surface.act({ type: 'click', nodeId: resolved.node.nodeId });
      return {};
    }

    case 'run-capability': {
      if (!options.runCapability) {
        // Declared but unwired. Escalating is the honest response: the artifact
        // says a prerequisite capability should run, and it cannot, so a person
        // has to decide -- not a silent skip that later fails as a checkpoint.
        return {
          escalate: `Recovery needs capability "${rule.then.capabilityId}", which this runtime cannot invoke.`,
        };
      }
      const ok = await options.runCapability(rule.then.capabilityId, rule.then.version);
      if (!ok) return { escalate: `Recovery capability "${rule.then.capabilityId}" did not succeed.` };
      // With a restart point declared, the flow resumes from there and this
      // step will run again in sequence; re-firing it here would double it.
      if (!rule.restartFrom && originalAction) {
        await options.surface.act(await refreshAction(step, originalAction, env));
      }
      return {};
    }

    case 'escalate':
      return { escalate: rule.then.reason };
  }
}

/**
 * Re-resolves a step's target before retrying it.
 *
 * Node ids are ephemeral -- valid only within the observation that produced
 * them -- so a retry that reuses the original action addresses a node that no
 * longer exists. Re-resolving is what makes "retry" mean "do the step again"
 * rather than "do the same stale thing again".
 */
async function refreshAction(
  step: Step,
  fallback: Action,
  env: { ctx: ReplayContext; resolveValue: (spec: ValueSpec) => string | undefined },
): Promise<Action> {
  if (!step.target) return fallback;

  const observation = await observe(env.ctx.options.surface, false);
  const resolved = resolveTarget(step.target, observation);
  if (!resolved.ok) return fallback;

  return toAction(step, resolved.node.nodeId, env.resolveValue, env.ctx.options.baseUrl);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAction(
  step: Step,
  nodeId: string | undefined,
  resolveValue: (spec: ValueSpec) => string | undefined,
  baseUrl: string,
): Action {
  switch (step.action.type) {
    case 'click':
      return { type: 'click', nodeId: nodeId! };
    case 'read':
      return { type: 'read', nodeId: nodeId! };
    case 'type':
      return {
        type: 'type',
        nodeId: nodeId!,
        text: resolveValue(step.action.value) ?? '',
        secret: step.action.value.from === 'secret',
      };
    case 'select':
      return { type: 'select', nodeId: nodeId!, option: resolveValue(step.action.option) ?? '' };
    case 'press':
      return { type: 'press', key: step.action.key };
    case 'wait':
      return { type: 'wait', ms: step.action.ms };
    case 'navigate': {
      const values: Record<string, string> = {};
      for (const [name, spec] of Object.entries(step.action.location.params)) {
        values[name] = resolveValue(spec) ?? '';
      }
      return { type: 'navigate', location: baseUrl.replace(/\/$/, '') + expandPath(step.action.location.pathTemplate, values) };
    }
  }
}

function valueResolver(
  inputs: Record<string, string>,
  secrets: SecretResolver | undefined,
): (spec: ValueSpec) => string | undefined {
  return (spec) => {
    switch (spec.from) {
      case 'literal':
        return spec.value;
      case 'param':
        return inputs[spec.param];
      case 'secret':
        return secrets?.(spec.ref);
    }
  };
}

/** Checked before the browser opens; a missing credential is not a UI failure. */
function firstMissingSecret(
  artifact: CapabilityArtifact,
  resolveValue: (spec: ValueSpec) => string | undefined,
): string | undefined {
  for (const step of artifact.steps) {
    const specs: ValueSpec[] =
      step.action.type === 'type'
        ? [step.action.value]
        : step.action.type === 'select'
          ? [step.action.option]
          : [];
    for (const spec of specs) {
      if (spec.from === 'secret' && !resolveValue(spec)) return spec.ref;
    }
  }
  return undefined;
}

function detectOutcome(outcomes: BusinessOutcome[], ctx: { observation: Observation; path: string }) {
  return outcomes.find((o) => evaluate(o.detect, ctx));
}

/**
 * Promotes a generic checkpoint failure to a specific code when the screen says
 * what went wrong. A run that failed because the host returned an error screen
 * is a different problem from one that failed because the flow is wrong, and
 * the person triaging it should not have to read the screenshot to find out.
 */
function classifyScreen(observation: Observation): FailureCode | undefined {
  const text = observation.text;
  if (/Unexpected System Error|SYS-500/i.test(text)) return 'APP_ERROR';
  if (/session has expired/i.test(text)) return 'SESSION_LOST';
  return undefined;
}

function collectPathTemplates(artifact: CapabilityArtifact): string[] {
  const templates = new Set<string>();

  for (const step of artifact.steps) {
    if (step.action.type === 'navigate') templates.add(step.action.location.pathTemplate);
  }
  const walk = (cp: Checkpoint): void => {
    if (cp.kind === 'location-matches') templates.add(cp.pathTemplate);
    if (cp.kind === 'all' || cp.kind === 'any') cp.of.forEach(walk);
    if (cp.kind === 'not') walk(cp.of);
  };
  walk(artifact.successCheckpoint);
  artifact.steps.forEach((s) => s.checkpoint && walk(s.checkpoint));
  artifact.outcomes.forEach((o) => walk(o.detect));

  return [...templates];
}

async function observe(surface: Surface, screenshot: boolean): Promise<Observation> {
  return surface.observe({ screenshot });
}

async function capture(
  evidence: EvidenceSink,
  surface: Surface,
  name: string,
  fallback: Observation,
): Promise<{ screenshotPath?: string; observationPath?: string }> {
  // The richer-signal-on-failure requirement. A screenshot shows what it looked
  // like and the observation shows what the system perceived; when those two
  // disagree, the disagreement is the bug.
  const observation = await surface.observe({ screenshot: true }).catch(() => fallback);
  const out: { screenshotPath?: string; observationPath?: string } = {};

  if (observation.screenshot) {
    const path = await evidence.screenshot(name, observation.screenshot).catch(() => '');
    if (path) out.screenshotPath = path;
  }
  const obsPath = await evidence.observation(name, observation).catch(() => '');
  if (obsPath) out.observationPath = obsPath;

  return out;
}

function describeAction(action: Action, step: Step): string {
  // Never the typed text. A secret is obviously excluded, but an ordinary
  // parameter can be regulated too, so the log records the shape of the action
  // and the artifact records what was meant.
  switch (action.type) {
    case 'type':
      return `type into ${step.target?.description ?? 'control'} (value withheld)`;
    case 'select':
      return `select "${action.option}" in ${step.target?.description ?? 'control'}`;
    case 'navigate':
      return `navigate to ${action.location}`;
    default:
      return `${action.type} ${step.target?.description ?? ''}`.trim();
  }
}

/** Regulated outputs are recorded by name and type, never by value. */
function redactOutputs(outputs: Outputs): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, o]) => [
      name,
      o.sensitivity === 'restricted' || o.sensitivity === 'secret'
        ? { type: o.type, value: '[REDACTED]' }
        : { type: o.type, value: o.value },
    ]),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Result construction
// ---------------------------------------------------------------------------

function envelope(ctx: ReplayContext) {
  const finishedAt = new Date();
  const degradedSteps = ctx.steps.filter((s) => s.resolution?.degraded).length;
  const weakestRank = ctx.steps.reduce((worst, s) => Math.max(worst, s.resolution?.rank ?? 0), 0);

  return {
    runId: ctx.runId,
    capabilityId: ctx.artifact.capability.id,
    capabilityVersion: ctx.artifact.capability.version,
    artifactDigest: digest(ctx.artifact),
    tenantId: ctx.options.tenantId,
    mode: ctx.options.mode,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - ctx.startedAt.getTime(),
    steps: ctx.steps,
    degradation: {
      degradedSteps,
      weakestRank,
      ...(ctx.versionDrift
        ? {
            productVersionDrift: {
              recordedAgainst: ctx.versionDrift.recordedAgainst,
              ranAgainst: ctx.versionDrift.bindingTo,
            },
          }
        : {}),
    },
    evidencePath: ctx.evidence.path,
  };
}

function failed(ctx: ReplayContext, failure: Failure): ReplayResult {
  void ctx.evidence.event({
    at: new Date().toISOString(),
    kind: 'replay.failed',
    runId: ctx.runId,
    failure,
  });
  return { ...envelope(ctx), status: 'failed', failure };
}

async function businessOutcome(
  ctx: ReplayContext,
  outcome: BusinessOutcome,
  observation: Observation,
  pathTemplates: string[],
): Promise<ReplayResult> {
  const { outputs } = extractOutputs(outcome.outputs, {
    observation,
    path: pathOf(observation.location),
    pathTemplates,
  });

  await ctx.evidence.event({
    at: new Date().toISOString(),
    kind: 'replay.business-outcome',
    runId: ctx.runId,
    code: outcome.code,
    title: outcome.title,
  });

  return {
    ...envelope(ctx),
    status: 'business-outcome',
    outcome: { code: outcome.code, title: outcome.title, message: outcome.description },
    outputs,
  };
}

/**
 * Hands the run to a person, and decides what is left of it afterwards.
 *
 * The three answers are `stop` (nobody resolved it, or they decided it must
 * not proceed), `retry` (the blockage is cleared and the step is ours to
 * perform), and `verified` (a person did the work and the step's own condition
 * now holds).
 *
 * The last one carries the rule that makes a handback trustworthy: the
 * executor re-evaluates the step's checkpoint against the screen the operator
 * left behind. "They said they did it" is not evidence, and a capability that
 * resumed on an operator's word would report success for work that never
 * happened -- which in this domain is the same failure as doing the wrong
 * thing, arrived at more politely.
 */
type EscalationHandled =
  | { kind: 'stop'; result: ReplayResult }
  | { kind: 'retry' }
  | { kind: 'verified' };

async function handleEscalation(
  ctx: ReplayContext,
  outcome: Extract<StepOutcome, { kind: 'escalate' }>,
  step: Step,
  budget: number,
): Promise<EscalationHandled> {
  const { options, evidence } = ctx;
  const { reason, message } = outcome;

  const shot = await capture(evidence, options.surface, `${step.id}-escalation`, outcome.observation);

  const request: EscalationRequest = {
    runId: ctx.runId,
    capabilityId: ctx.artifact.capability.id,
    reason,
    message,
    stepId: step.id,
    intent: step.intent,
    observation: outcome.observation,
    ...shot,
  };

  const handled: EscalationHandling = (await options.escalate?.(request)) ?? {
    sessionId: `unbrokered-${ctx.runId}`,
    interventionId: randomUUID(),
  };

  await evidence.event({
    at: new Date().toISOString(),
    kind: 'replay.escalated',
    runId: ctx.runId,
    reason,
    message,
    stepId: step.id,
    interventionId: handled.interventionId,
    sessionId: handled.sessionId,
    disposition: handled.disposition ?? null,
    operator: handled.operator ?? null,
  });

  const stop = (why: string): EscalationHandled => ({
    kind: 'stop',
    result: {
      ...envelope(ctx),
      status: 'escalated',
      escalation: {
        reason,
        message: why,
        stepId: step.id,
        sessionId: handled.sessionId,
        interventionId: handled.interventionId,
      },
    },
  });

  if (!handled.disposition || !resumes(handled.disposition)) {
    return stop(message);
  }

  if (budget <= 0) {
    return stop(
      `${message} The run has already stopped for a person as many times as it is allowed to, so it ` +
        'is not resuming again.',
    );
  }

  if (outcome.resume === 'retry') {
    outcome.report.status = 'recovered';
    return { kind: 'retry' };
  }

  // ---- the operator says the step is done. Check. --------------------------

  const observation = await observe(options.surface, false);
  const checkCtx = { observation, path: pathOf(observation.location) };

  // Outcomes first, exactly as everywhere else in this executor. A person who
  // took over and found "no such member" has produced an answer, and reporting
  // that as a broken capability would be the mistake the whole result contract
  // is shaped to prevent.
  const declared = detectOutcome(ctx.artifact.outcomes, checkCtx);
  if (declared) {
    outcome.report.status = 'recovered';
    return {
      kind: 'stop',
      result: await businessOutcome(ctx, declared, observation, collectPathTemplates(ctx.artifact)),
    };
  }

  if (step.checkpoint && !evaluate(step.checkpoint, checkCtx)) {
    const failureShot = await capture(evidence, options.surface, `${step.id}-handback`, observation);
    outcome.report.status = 'failed';
    outcome.report.expected = explain(step.checkpoint, checkCtx);
    outcome.report.observed = summariseScreen(checkCtx);

    return {
      kind: 'stop',
      result: failed(ctx, {
        code: 'CHECKPOINT_FAILED',
        message:
          `An operator returned step "${step.id}" (${step.intent}) as complete, but the condition ` +
          'the artifact declares for it still does not hold.',
        stepId: step.id,
        expected: describeCheckpoint(step.checkpoint),
        observed: summariseScreen(checkCtx),
        ...failureShot,
      }),
    };
  }

  if (!step.checkpoint) {
    // Nothing to check against. Said out loud in the log rather than passed
    // over, because "resumed unverified" is the one case where the guarantee
    // above does not apply and a reviewer should know which steps those were.
    await evidence.event({
      at: new Date().toISOString(),
      kind: 'replay.resumed-unverified',
      runId: ctx.runId,
      stepId: step.id,
      interventionId: handled.interventionId,
    });
  }

  outcome.report.status = 'recovered';
  return { kind: 'verified' };
}

function preflightFailure(
  runId: string,
  startedAt: Date,
  evidence: EvidenceSink,
  options: ReplayOptions,
  failure: Failure,
): ReplayResult {
  const finishedAt = new Date();
  void evidence.event({ at: finishedAt.toISOString(), kind: 'replay.failed', runId, failure });

  return {
    runId,
    capabilityId: 'unknown',
    capabilityVersion: '0.0.0',
    artifactDigest: '',
    tenantId: options.tenantId,
    mode: options.mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps: [],
    degradation: { degradedSteps: 0, weakestRank: 0 },
    evidencePath: evidence.path,
    status: 'failed',
    failure,
  };
}
