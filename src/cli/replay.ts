/**
 * `replay` -- the production path, from a terminal.
 *
 * There is no model in anything this command does, and that is structural
 * rather than a promise: `src/replay/` imports nothing from `src/llm/`, so the
 * only way to get a decision from a model here would be to add an import that
 * review would see.
 *
 * What this file contributes beyond calling `replay()` is the escalation seam.
 * The executor knows how to stop and ask for a person and how to carry on once
 * one has dealt with it; it does not know what "a person" means in a given
 * deployment. Here that means a `SessionBroker` owning the live browser, a
 * small HTTP console somebody can point `npm run operator` at, and a bounded
 * wait. Wire a rota system in instead and nothing in the executor changes.
 *
 * Note which surface the executor is handed: `controlledSurface`, not the raw
 * one. The run drives the session through a wrapper that checks the control
 * token before every action, so the instant the broker moves control to a
 * person the automation is refused rather than trusted to stop.
 *
 * Exit codes distinguish the four results, because a shell is a caller too:
 * 0 success, 2 a declared business outcome, 3 escalated and not resumed,
 * 1 failed. Collapsing outcome into failure at the very last step would undo
 * the distinction the whole result contract exists to make.
 */

import { randomUUID } from 'node:crypto';
import { relativeEvidencePath } from '../evidence/fileSink.js';
import { SessionBroker, controlledSurface, type Intervention } from '../hitl/index.js';
import { replay, type EscalationHandling, type EscalationRequest } from '../replay/index.js';
import type { Outputs, ReplayResult } from '../artifact/result.js';
import type { Args } from './args.js';
import { UsageError } from './args.js';
import {
  armFaults,
  openEvidence,
  openSurface,
  requireTargetRunning,
  resolveTarget,
  secretResolver,
  TARGET_FLAGS,
} from './context.js';
import { startOperatorConsole, type OperatorConsole } from './operatorConsole.js';
import { DEFAULT_ARTIFACT_DIR, artifactPath, loadArtifact } from './store.js';
import {
  blue,
  bullet,
  dim,
  duration,
  green,
  heading,
  kv,
  line,
  note,
  red,
  section,
  shortPath,
  warn,
  yellow,
} from './ui.js';

export const REPLAY_FLAGS = [
  ...TARGET_FLAGS,
  'artifact',
  'capability',
  'dir',
  'input',
  'unattended',
  'console-port',
  'wait-ms',
  'timeout-ms',
  'max-escalations',
];

const EXIT = { success: 0, failed: 1, 'business-outcome': 2, escalated: 3 } as const;

export async function replayCommand(args: Args): Promise<number> {
  args.rejectUnknown(REPLAY_FLAGS);

  const ctx = resolveTarget(args);
  const inputs = args.pairs('input');
  const unattended = args.bool('unattended');
  const mode = unattended ? 'unattended' : 'attended';

  // ---- the artifact, before anything expensive -----------------------------

  const path = resolveArtifactPath(args);
  const loaded = loadArtifact(path);

  if (!loaded.ok) {
    heading(`Refusing to run ${shortPath(path)}`);
    for (const issue of loaded.issues) bullet(`${issue.path}: ${issue.message}`);
    line();
    note('An artifact is validated before a browser exists. Nothing was opened.');
    line();
    return 1;
  }

  const { artifact } = loaded;
  for (const warning of loaded.warnings) warn(`${warning.path}: ${warning.message}`);

  await requireTargetRunning(ctx);
  if (args.list('fault').length) await armFaults(ctx, args.list('fault'));

  // ---- the run --------------------------------------------------------------

  const runId = randomUUID();
  const evidence = openEvidence(ctx, 'replay', runId, artifact.capability.id);

  heading(`Replaying ${green(artifact.capability.id)} ${dim(`v${artifact.capability.version}`)}`);
  kv('institution', `${ctx.tenant.institution} (tenant ${ctx.tenantId})`);
  kv('target', ctx.baseUrl);
  kv('mode', mode);
  kv('inputs', Object.keys(inputs).join(', ') || '(none)');
  kv('evidence', relativeEvidencePath(evidence));

  const surface = await openSurface(ctx, mode);
  const broker = new SessionBroker({ surface, evidence, sessionId: runId });
  const automation = controlledSurface(surface, broker, broker.automationToken);

  let operatorConsole: OperatorConsole | undefined;
  if (!unattended) {
    operatorConsole = await startOperatorConsole({
      broker,
      port: args.num('console-port', Number(process.env.OPERATOR_PORT ?? 4180)),
      evidencePath: evidence.path,
      capabilityId: artifact.capability.id,
    });
    kv('operator console', operatorConsole.url);
  }

  // Attended runs wait for a real person; unattended ones have nobody to wait
  // for, so the intervention is still recorded and then expires at once. That
  // is the honest unattended answer -- a run that needed a human and could not
  // have one -- rather than a silent failure with a different name.
  const waitMs = args.num('wait-ms', unattended ? 0 : 10 * 60_000);

  const escalate = async (request: EscalationRequest): Promise<EscalationHandling> => {
    const intervention = await broker.raise({
      runId: request.runId,
      capabilityId: request.capabilityId,
      reason: request.reason,
      message: request.message,
      ...(request.stepId ? { stepId: request.stepId } : {}),
      ...(request.intent ? { intent: request.intent } : {}),
      ...(request.screenshotPath ? { screenshotPath: request.screenshotPath } : {}),
      ...(request.observationPath ? { observationPath: request.observationPath } : {}),
    });

    announceEscalation(intervention, operatorConsole, waitMs);

    const resolution = await broker.waitForResolution(intervention.id, { timeoutMs: waitMs });

    return {
      sessionId: resolution.sessionId,
      interventionId: resolution.interventionId,
      disposition: resolution.disposition,
      ...(resolution.operator ? { operator: resolution.operator } : {}),
      ...(resolution.note ? { note: resolution.note } : {}),
    };
  };

  let result: ReplayResult;
  try {
    result = await replay({
      artifact,
      inputs,
      tenantId: ctx.tenantId,
      baseUrl: ctx.baseUrl,
      mode,
      surface: automation,
      secrets: secretResolver(ctx),
      productVersion: ctx.tenant.productVersion,
      evidence,
      runId,
      escalate,
      maxEscalations: args.num('max-escalations', 2),
      timeoutMs: args.num('timeout-ms', 180_000),
    });
  } finally {
    await operatorConsole?.close();
    // The broker owns the session's lifetime, not the executor -- closing it
    // here is the one place that is true, which is why ControlledSurface.close
    // is deliberately inert.
    await broker.close().catch(() => {});
  }

  await evidence.file('result.json', JSON.stringify(result, null, 2));

  render(result, evidence.path);

  return EXIT[result.status];
}

// ---------------------------------------------------------------------------

function resolveArtifactPath(args: Args): string {
  const explicit = args.str('artifact');
  const id = args.str('capability');

  if (explicit && id) {
    throw new UsageError('Give either --artifact <path> or --capability <id>, not both.');
  }
  if (explicit) return explicit;
  if (id) return artifactPath(args.str('dir', DEFAULT_ARTIFACT_DIR), id);

  throw new UsageError(
    'Which capability? Pass --artifact <path> or --capability <id>. ' +
      'Run "npm run catalog" to see what is available.',
  );
}

function announceEscalation(
  intervention: Intervention,
  operatorConsole: OperatorConsole | undefined,
  waitMs: number,
): void {
  heading(`${yellow('Stopped. This needs a person.')}`);
  kv('reason', intervention.reason);
  kv('step', intervention.stepId);
  kv('intent', intervention.intent);
  kv('stopped on', intervention.title);
  line();
  line(`  ${intervention.message}`);
  line();

  if (!operatorConsole) {
    note('Unattended: there is nobody to hand this to, so the run stops here.');
    return;
  }

  // Control has already moved. Said out loud because the window between
  // raising and somebody arriving is precisely when a stray retry would act on
  // a screen the system has admitted it cannot read.
  note('The automation no longer holds this session. In another terminal:');
  line(`      ${blue(`npm run operator -- --url ${operatorConsole.url}`)}`);
  note(`Waiting up to ${duration(waitMs)}. After that the intervention expires and the run stops.`);
}

// ---------------------------------------------------------------------------
// The four-way result
// ---------------------------------------------------------------------------

function render(result: ReplayResult, evidencePath: string): void {
  heading(headline(result));

  kv('run', result.runId);
  kv('took', duration(result.durationMs));
  kv('steps', `${result.steps.length} (${result.steps.filter((s) => s.status === 'recovered').length} recovered, ${result.steps.filter((s) => s.status === 'skipped').length} skipped)`);

  switch (result.status) {
    case 'success':
      renderOutputs(result.outputs);
      break;

    case 'business-outcome':
      // Printed as an answer, with its code, because that is what it is. A
      // caller switches on this; it is not a softer kind of failure.
      kv('outcome', `${result.outcome.code} -- ${result.outcome.title}`);
      if (result.outcome.message) note(result.outcome.message);
      renderOutputs(result.outputs);
      break;

    case 'escalated':
      kv('reason', result.escalation.reason);
      kv('intervention', result.escalation.interventionId);
      line();
      line(`  ${result.escalation.message}`);
      break;

    case 'failed':
      kv('code', red(result.failure.code));
      kv('step', result.failure.stepId);
      line();
      line(`  ${result.failure.message}`);
      if (result.failure.expected) {
        line();
        kv('expected', result.failure.expected);
        kv('observed', result.failure.observed);
      }
      if (result.failure.screenshotPath) {
        kv('screenshot', shortPath(`${evidencePath}/${result.failure.screenshotPath}`));
      }
      if (result.failure.observationPath) {
        // The pair is the point: the screenshot is what it looked like, the
        // observation is what the system perceived, and a disagreement between
        // them is the bug.
        kv('observation', shortPath(`${evidencePath}/${result.failure.observationPath}`));
      }
      break;
  }

  renderDegradation(result);

  line();
  kv('evidence', shortPath(evidencePath));
  line();
}

function headline(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return green('Success');
    case 'business-outcome':
      return blue(`Business outcome: ${result.outcome.code}`);
    case 'escalated':
      return yellow('Escalated and not resumed');
    case 'failed':
      return red(`Failed: ${result.failure.code}`);
  }
}

function renderOutputs(outputs: Outputs): void {
  const entries = Object.values(outputs);
  if (!entries.length) return;

  section('returned');
  for (const output of entries) {
    // Declared sensitivity decides what a terminal is allowed to show. The
    // artifact says which outputs are regulated; honouring that here rather
    // than at the call site is what makes the declaration mean something.
    const shown =
      output.sensitivity === 'restricted' || output.sensitivity === 'secret'
        ? dim(`[${output.sensitivity}, not printed]`)
        : output.value;
    bullet(`${output.name} ${dim(`(${output.type})`)}  ${shown}`);
  }
}

/**
 * How much the run had to lean on fallbacks to work at all.
 *
 * Reported on success as well as failure, because a run that only worked by
 * falling down the locator ladder is the earliest available warning that a
 * tenant's screens have moved -- and it is the run worth looking at before it
 * becomes the run that did not work.
 */
function renderDegradation(result: ReplayResult): void {
  const { degradedSteps, weakestRank, productVersionDrift } = result.degradation;

  if (degradedSteps) {
    warn(`${degradedSteps} step(s) resolved below the strongest available strategy (worst rank ${weakestRank}).`);
    for (const step of result.steps.filter((s) => s.resolution?.degraded)) {
      bullet(`${step.stepId}: resolved by ${step.resolution?.strategyKind} at rank ${step.resolution?.rank}`);
    }
  }

  if (productVersionDrift) {
    warn(
      `Recorded against ${productVersionDrift.recordedAgainst}, ran against ${productVersionDrift.ranAgainst}.`,
    );
  }

  if (result.steps.some((s) => s.recoveries.length)) {
    section('recoveries');
    for (const step of result.steps.filter((s) => s.recoveries.length)) {
      for (const recovery of step.recoveries) {
        bullet(
          `${step.stepId}: ${recovery.description} ${dim(
            `(${recovery.action}, attempt ${recovery.attempt}, ${recovery.succeeded ? 'worked' : 'did not'})`,
          )}`,
        );
      }
    }
  }
}

/** Exported for the help text, so usage and behaviour cannot disagree. */
export function replayExitCodes(): string {
  return Object.entries(EXIT)
    .map(([status, code]) => `${code} ${status}`)
    .join(', ');
}
