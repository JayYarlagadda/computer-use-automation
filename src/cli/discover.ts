/**
 * `discover` -- the one part of the system that has a model in the loop.
 *
 * It drives a live surface with an LLM until the goal is reached, then hands
 * the recording to the compiler, which turns it into something that never
 * needs a model again. The whole value of the command is that boundary, so it
 * is worth being precise about where it sits.
 *
 * Inside the loop the model chooses what to do, constrained by a typed tool
 * vocabulary and refused by the policy choke point when it asks for something
 * it may not have. Outside the loop there is exactly one further model call,
 * for prose: a title, descriptions, and candidate business outcomes. Nothing
 * else the model says survives -- steps, locators, checkpoints and extraction
 * rules are computed from the trace and verified against the observations that
 * were actually recorded.
 *
 * Which means a discovery run has two independent ways to end badly, and they
 * are reported separately on purpose. The run can fail to reach the goal, in
 * which case there is nothing to compile. Or the run can succeed and the
 * compiler can still refuse, because what the model did cannot be expressed as
 * a contract that would hold for anyone but this member on this afternoon.
 * The second is the more interesting failure and the one this command prints
 * in most detail, because it is the compiler doing its job.
 *
 * Credentials are passed by *name* (`--secret MERIDIAN_OPERATOR_PASSWORD`,
 * value read from the environment) and never appear in a flag. The compiler is
 * given the values only so that text typed during the run can be recognised
 * and replaced with a reference; nothing writes one down.
 */

import { randomUUID } from 'node:crypto';
import { relativeEvidencePath } from '../evidence/fileSink.js';
import { createProviderFromEnv, hasLlmCredentials, readProviderConfig } from '../llm/factory.js';
import type { LlmProvider } from '../llm/types.js';
import {
  compile,
  discover,
  effectiveSteps,
  proposeMetadata,
  type AuthoringProposal,
  type CompileReport,
  type DiscoveryRun,
  type GoalInput,
} from '../agent/index.js';
import type { CapabilityArtifact } from '../artifact/index.js';
import type { Args } from './args.js';
import { UsageError } from './args.js';
import {
  armFaults,
  openEvidence,
  openSurface,
  requireTargetRunning,
  resolveTarget,
  TARGET_FLAGS,
} from './context.js';
import { DEFAULT_ARTIFACT_DIR, artifactPath, saveArtifact } from './store.js';
import {
  blue,
  bullet,
  describeError,
  dim,
  duration,
  green,
  heading,
  kv,
  line,
  note,
  problem,
  red,
  section,
  shortPath,
  warn,
  yellow,
} from './ui.js';

export const DISCOVER_FLAGS = [
  ...TARGET_FLAGS,
  'goal',
  'input',
  'capability',
  'version',
  'title',
  'description',
  'vendor',
  'dir',
  'out',
  'max-turns',
  'budget-ms',
  'no-authoring',
  'dry-run',
];

export async function discoverCommand(args: Args): Promise<number> {
  args.rejectUnknown(DISCOVER_FLAGS);

  const capabilityId = args.required('capability', 'It is the dotted id the artifact is stored under, e.g. meridian.member.read-savings-balance.');
  const goalTemplate = args.required('goal', 'Say what you want done, in English.');
  const inputs = toGoalInputs(args.pairs('input'));
  const goal = expandGoal(goalTemplate, inputs);

  const ctx = resolveTarget(args);

  if (!hasLlmCredentials()) {
    const config = readProviderConfig();
    line();
    problem(`Discovery needs a model, and ${config.keyVar} is not set.`);
    note('Everything else in this project works without one -- replay never calls a model.');
    note('Add a key with:  npm run set-key      then confirm it with:  npm run env -- --ping');
    line();
    return 1;
  }

  let provider: LlmProvider;
  try {
    provider = createProviderFromEnv();
  } catch (error) {
    problem(describeError(error));
    return 1;
  }

  await requireTargetRunning(ctx);
  if (args.list('fault').length) await armFaults(ctx, args.list('fault'));

  const runId = randomUUID();
  const evidence = openEvidence(ctx, 'discovery', runId, capabilityId);

  heading(`Discovering ${green(capabilityId)}`);
  kv('goal', goal);
  kv('inputs', inputs.map((i) => i.name).join(', ') || '(none)');
  kv('credentials', Object.keys(ctx.secrets).join(', ') || '(none)');
  kv('institution', `${ctx.tenant.institution} (tenant ${ctx.tenantId})`);
  kv('target', ctx.baseUrl);
  kv('model', `${provider.name} / ${provider.model}`);
  kv('evidence', relativeEvidencePath(evidence));
  line();
  note('Driving a live browser. Every action passes the same policy choke point replay uses.');

  // ---- the loop -------------------------------------------------------------

  const surface = await openSurface(ctx, 'discovery');
  let run: DiscoveryRun;

  try {
    // The agent's `navigate` tool takes a path and the loop starts from
    // wherever the surface already is, so somebody has to put it on the
    // application's front door. That is a deployment fact, not a decision the
    // model should spend a turn on.
    await surface.act({ type: 'navigate', location: `${ctx.baseUrl}/` });

    run = await discover({
      goal,
      inputs,
      surface,
      provider,
      policy: ctx.policy,
      evidence,
      allowedRoutes: ctx.policy.config.allowedRoutes,
      secrets: ctx.secrets,
      maxTurns: args.num('max-turns', 24),
      budgetMs: args.num('budget-ms', 5 * 60_000),
      runId,
    });
  } finally {
    await surface.close();
  }

  renderRun(run);
  await evidence.file('discovery-run.json', JSON.stringify(summarise(run), null, 2));

  if (run.status !== 'succeeded') {
    line();
    note('Nothing to compile: only a run that reached its goal becomes a capability.');
    note(`The trace and its evidence are still in ${shortPath(evidence.path)}.`);
    line();
    return 1;
  }

  // ---- the one out-of-loop model call ---------------------------------------

  const authoring = args.bool('no-authoring') ? undefined : await author(provider, run, capabilityId);

  // ---- trace -> contract -----------------------------------------------------

  const result = compile({
    run,
    capability: {
      id: capabilityId,
      version: args.str('version', '1.0.0'),
      ...(args.str('title') ? { title: args.str('title')! } : {}),
      ...(args.str('description') ? { description: args.str('description')! } : {}),
    },
    app: {
      vendor: args.str('vendor', 'Meridian Systems'),
      product: ctx.tenant.product,
      productVersion: ctx.tenant.productVersion,
      surfaceKind: 'browser',
      recordedOnTenant: ctx.tenantId,
    },
    policy: ctx.policy,
    secrets: ctx.secrets,
    ...(authoring ? { authoring } : {}),
  });

  renderCompile(result.report);
  await evidence.file('compile-report.json', JSON.stringify(result.report, null, 2));

  if (!result.ok) {
    line();
    problem('The run reached its goal, but it does not compile into a contract.');
    note('That is the compiler working: it refuses to emit anything it could not verify');
    note('against the recording, or anything that would only ever be true for this run.');
    line();
    return 1;
  }

  for (const warning of result.warnings) warn(`${warning.path}: ${warning.message}`);

  await evidence.file('capability.json', JSON.stringify(result.artifact, null, 2));
  const written = args.bool('dry-run') ? undefined : write(args, result.artifact);

  renderArtifact(result.artifact, evidence.path, written);
  return 0;
}

// ---------------------------------------------------------------------------
// Inputs and the goal
// ---------------------------------------------------------------------------

function toGoalInputs(pairs: Record<string, string>): GoalInput[] {
  return Object.entries(pairs).map(([name, value]) => ({ name, value }));
}

/**
 * Lets the goal be written the way the capability will be called.
 *
 * `--goal "read the savings balance for member {memberId}"` is expanded with
 * this run's value before the model sees it, and the compiler puts the
 * placeholder back when it writes provenance. The alternative -- typing the
 * concrete number into the goal -- works identically for the model and reads,
 * in the committed artifact, like a capability about one member.
 */
function expandGoal(template: string, inputs: GoalInput[]): string {
  let goal = template;
  for (const input of inputs) goal = goal.split(`{${input.name}}`).join(input.value);

  const unresolved = [...goal.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  if (unresolved.length) {
    throw new UsageError(
      `The goal refers to ${unresolved.map((n) => `{${n}}`).join(', ')}, which no --input supplies.`,
    );
  }
  return goal;
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

async function author(
  provider: LlmProvider,
  run: DiscoveryRun,
  capabilityId: string,
): Promise<AuthoringProposal | undefined> {
  const success = run.success!;

  const outcome = await proposeMetadata(provider, {
    goal: run.goal,
    capabilityId,
    inputNames: run.inputs.map((i) => i.name),
    outputs: success.outputs.map((o) => ({ name: o.name, type: o.type })),
    intents: effectiveSteps(run).map((step) => step.why),
    successScreenText: success.finalObservation.text,
  });

  if (!outcome.ok) {
    // Non-fatal by design: the compiler derives descriptions from the trace
    // when there is no proposal, which is what lets the whole pipeline run in
    // CI with no key.
    warn(`Authoring call did not produce metadata (${outcome.reason}). Falling back to trace-derived text.`);
    return undefined;
  }

  return outcome.proposal;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function renderRun(run: DiscoveryRun): void {
  heading(runHeadline(run));

  kv('turns', `${run.turns}`);
  kv('took', duration(run.elapsedMs));
  kv('tokens', run.usage.totalTokens ? `${run.usage.totalTokens} (${run.usage.promptTokens} in, ${run.usage.completionTokens} out)` : undefined);
  kv('actions', `${run.steps.length} attempted, ${effectiveSteps(run).length} took effect`);

  switch (run.status) {
    case 'succeeded':
      kv('summary', run.success?.summary);
      kv('proved by', run.success?.successText ? `"${run.success.successText}"` : undefined);
      if (run.success?.outputs.length) {
        section('declared outputs');
        for (const output of run.success.outputs) {
          bullet(`${output.name} ${dim(`(${output.type}, ${output.sensitivity})`)}`);
        }
      }
      break;
    case 'business-outcome':
      kv('outcome', `${run.outcome?.code} -- ${run.outcome?.title}`);
      note(run.outcome?.description ?? '');
      break;
    case 'escalated':
      kv('reason', run.escalation?.reason);
      break;
    case 'abandoned':
      kv('reason', run.abandonment?.reason);
      break;
    case 'failed':
      kv('code', red(run.failure?.code ?? 'UNKNOWN'));
      line();
      line(`  ${run.failure?.message ?? ''}`);
      break;
  }

  const refused = run.steps.filter((s) => s.refusal);
  if (refused.length) {
    // Worth surfacing even on a successful run: a model that had to be refused
    // three times on the way to the answer is a prompt problem, and the
    // refusals are also the evidence that the choke point is load-bearing.
    kv('refused by policy', `${refused.length}`);
    for (const step of refused) bullet(`${step.refusal!.code}: ${step.refusal!.reason}`);
  }
}

function runHeadline(run: DiscoveryRun): string {
  switch (run.status) {
    case 'succeeded':
      return green('The agent reached the goal');
    case 'business-outcome':
      return blue(`The application answered: ${run.outcome?.code}`);
    case 'escalated':
      return yellow('The agent asked for a human');
    case 'abandoned':
      return yellow('The agent gave up');
    case 'failed':
      return red(`The run failed: ${run.failure?.code}`);
  }
}

function renderCompile(report: CompileReport): void {
  heading('Compiling the trace into a contract');
  kv('steps', `${report.stepsExplored} explored, ${report.stepsKept} kept`);

  for (const dropped of report.dropped) {
    bullet(dim(`dropped "${dropped.intent}" -- ${dropped.why}`));
  }

  // Every rung is run through the real replay resolver against the observation
  // the model was looking at, so a refused rung is a rung that provably would
  // not have worked. Showing them is how the ladder stays reviewable.
  const refusedRungs = report.locators.flatMap((l) =>
    l.rungs.filter((r) => !r.accepted).map((r) => `${l.stepId}: ${r.summary} -- ${r.reason}`),
  );
  if (refusedRungs.length) {
    kv('locator rungs refused', `${refusedRungs.length}`);
    for (const rung of refusedRungs.slice(0, 8)) bullet(dim(rung));
  }

  if (report.outcomes.length) {
    section('business outcomes');
    for (const outcome of report.outcomes) {
      bullet(
        outcome.accepted
          ? `${green('kept')}     ${outcome.code}`
          : `${yellow('refused')}  ${outcome.code} ${dim(`-- ${outcome.reason}`)}`,
      );
    }
  }

  for (const issue of report.issues) {
    if (issue.severity === 'error') problem(`${issue.path}: ${issue.message}`);
    else warn(`${issue.path}: ${issue.message}`);
  }
}

function renderArtifact(artifact: CapabilityArtifact, evidencePath: string, written: string | undefined): void {
  heading(green('Compiled'));
  kv('capability', `${artifact.capability.id} v${artifact.capability.version}`);
  kv('title', artifact.capability.title);
  kv('steps', `${artifact.steps.length}`);
  kv('takes', artifact.inputs.map((i) => i.name).join(', ') || '(nothing)');
  kv('returns', artifact.outputs.map((o) => o.name).join(', ') || '(nothing)');
  kv('outcomes', artifact.outcomes.map((o) => o.code).join(', ') || '(none declared)');
  kv('risk', artifact.risk);
  kv('approval', `${artifact.approval.state} -- unattended replay is refused until a person approves it`);
  kv('evidence', shortPath(evidencePath));

  if (written) {
    kv('written to', shortPath(written));
    line();
    note('Try it:');
    line(
      `      ${blue(`npm run replay -- --capability ${artifact.capability.id} ` +
        artifact.inputs.map((i) => `--input ${i.name}=${i.example ?? '<value>'}`).join(' '))}`,
    );
  } else {
    line();
    note('--dry-run: the artifact was written to the evidence directory only.');
  }
  line();
}

function write(args: Args, artifact: CapabilityArtifact): string {
  const path = args.str('out') ?? artifactPath(args.str('dir', DEFAULT_ARTIFACT_DIR), artifact.capability.id);
  saveArtifact(path, artifact);
  return path;
}

/**
 * The run, minus the observations.
 *
 * A trace step holds two full perceptions of the screen, which is what the
 * compiler needs and what would make this file tens of megabytes of duplicated
 * node graphs. The observations are already on disk individually, one per turn,
 * so the summary keeps the decisions and points at those.
 */
function summariseAction(step: DiscoveryRun['steps'][number]) {
  if (step.secretRef) {
    return { type: 'type', nodeId: step.action.type === 'type' ? step.action.nodeId : undefined, secret: step.secretRef };
  }
  if (step.action.type === 'type') {
    return { type: 'type', nodeId: step.action.nodeId, chars: step.action.text.length };
  }
  return step.action;
}

function summarise(run: DiscoveryRun) {
  return {
    ...run,
    steps: run.steps.map((step) => ({
      index: step.index,
      turn: step.turn,
      why: step.why,
      action: summariseAction(step),
      ...(step.node ? { node: { role: step.node.role, name: step.node.name } } : {}),
      ...(step.secretRef ? { secretRef: step.secretRef } : {}),
      ok: step.ok,
      noChange: step.noChange ?? false,
      ...(step.refusal ? { refusal: step.refusal } : {}),
      ...(step.error ? { error: step.error } : {}),
      ...(step.screenshotPath ? { screenshotPath: step.screenshotPath } : {}),
    })),
    ...(run.success
      ? {
          success: {
            summary: run.success.summary,
            successText: run.success.successText,
            outputs: run.success.outputs,
            finalLocation: run.success.finalObservation.location,
          },
        }
      : {}),
    ...(run.outcome
      ? {
          outcome: {
            code: run.outcome.code,
            title: run.outcome.title,
            description: run.outcome.description,
            evidenceText: run.outcome.evidenceText,
          },
        }
      : {}),
  };
}
