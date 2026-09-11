/**
 * The replay result contract.
 *
 * This sits next to the artifact rather than inside the replay engine because
 * it is half of the same interface: the artifact says what you may call and
 * what you must pass, this says what you get back. A caller should be able to
 * program against both without reading a line of the executor.
 *
 * The shape is a four-way discriminated union, and the four are chosen to make
 * the mistake the brief warns about unrepresentable. "No such member" cannot be
 * returned as a failure here, because a failure has no place to put an outcome
 * code and an outcome has no place to put a stack trace. A caller that handles
 * `status` exhaustively has handled the business cases by construction.
 *
 *   success           the capability did what it said, here are the outputs
 *   business-outcome  a declared, legitimate answer that is not success
 *   escalated         stopped safely and handed to a human
 *   failed            something is wrong; here is everything needed to debug it
 *
 * `escalated` is a peer of the others rather than a species of failure on
 * purpose. An irreversible step reached under supervision and a run that got
 * stuck are the same event from the caller's point of view -- the work is
 * paused and a person has it -- and collapsing that into "failed" would lose
 * the one fact that determines what the caller does next.
 */

import type { Sensitivity, ValueType } from './schema.js';

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * An extracted value, carried with the type it was declared as.
 *
 * The declared type travels with the value rather than being looked up from
 * the artifact, so a result stored in evidence is self-describing a year later
 * when the capability has moved on three versions.
 */
export interface OutputValue {
  name: string;
  type: ValueType;
  value: string;
  sensitivity: Sensitivity;
}

export type Outputs = Record<string, OutputValue>;

// ---------------------------------------------------------------------------
// Per-step reporting
// ---------------------------------------------------------------------------

/**
 * Which rung of the locator ladder resolved a target.
 *
 * Recorded on every step, not just failing ones. This is the raw material for
 * drift detection: a step that used to resolve by `role-name` and now resolves
 * `structural` still succeeds, and is also the earliest available warning that
 * a tenant's screen has changed.
 */
export interface Resolution {
  strategyKind: 'role-name' | 'anchor' | 'structural' | 'coordinates';
  /** Index in the descriptor's ladder. 0 is the strongest available. */
  rank: number;
  /** True when anything below rank 0 was used. */
  degraded: boolean;
  /** How many nodes matched. Anything but 1 is a problem; see TARGET_AMBIGUOUS. */
  candidates: number;
}

export interface RecoveryReport {
  ruleId: string;
  description: string;
  action: string;
  attempt: number;
  succeeded: boolean;
}

export type StepStatus = 'ok' | 'skipped' | 'recovered' | 'failed';

export interface StepReport {
  stepId: string;
  /** Copied from the artifact so a report reads without the artifact to hand. */
  intent: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  resolution?: Resolution;
  /** Empty unless the step's checkpoint failed and recovery was attempted. */
  recoveries: RecoveryReport[];
  /** Present on failure: what was asserted and what was actually seen. */
  expected?: string;
  observed?: string;
  /** Path to the screenshot captured for this step, if one was. */
  screenshotPath?: string;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * The hard-failure taxonomy.
 *
 * Kept deliberately coarse. Each code answers a different question about what
 * to do next -- retry, fix the artifact, fix the input, call a person, page
 * someone about the app -- and codes that do not change the answer would be
 * detail masquerading as precision.
 */
export type FailureCode =
  /** Nothing on screen matched any rung of the ladder. */
  | 'TARGET_NOT_FOUND'
  /** Several nodes matched. Never guessed between; see D3. */
  | 'TARGET_AMBIGUOUS'
  /** The action ran but the screen is not what the artifact expected. */
  | 'CHECKPOINT_FAILED'
  /** The surface refused to perform the action at all. */
  | 'ACTION_FAILED'
  /** A required output could not be extracted. */
  | 'EXTRACTION_FAILED'
  /** A step, or the run, exceeded its budget. */
  | 'TIMEOUT'
  /** The guardrail refused. Includes landing off the allowlist. */
  | 'POLICY_DENIED'
  /** The app itself errored -- a 500 screen, not our problem to retry forever. */
  | 'APP_ERROR'
  /** Session expired and re-authentication was unavailable or also failed. */
  | 'SESSION_LOST'
  /** Inputs did not satisfy the declared parameter specs. Fails before acting. */
  | 'INPUT_INVALID'
  /** The artifact is malformed or references things that do not exist. */
  | 'ARTIFACT_INVALID'
  /** Unattended replay of a capability that has not been approved. */
  | 'NOT_APPROVED';

export interface Failure {
  code: FailureCode;
  message: string;
  /** The step it happened at. Absent for pre-flight failures. */
  stepId?: string;
  /** Stated as an assertion a human can check: "text 'Member Detail' present". */
  expected?: string;
  observed?: string;
  /** Where the richer signal for this failure was written. */
  screenshotPath?: string;
  observationPath?: string;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export type EscalationReason =
  /** A declared irreversible step needs a person to approve it. */
  | 'APPROVAL_REQUIRED'
  /** Recovery ran out of options and the artifact says to escalate. */
  | 'RECOVERY_EXHAUSTED'
  /** The discovery loop or replay could not find a way forward. */
  | 'STUCK';

export interface Escalation {
  reason: EscalationReason;
  message: string;
  stepId?: string;
  /** Identifies the paused live session a human can attach to. */
  sessionId: string;
  /** The intervention record the operator console displays and resolves. */
  interventionId: string;
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export interface ReplayEnvelope {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  /** Content hash of the artifact actually executed, after tenant binding. */
  artifactDigest: string;
  tenantId: string;
  mode: 'unattended' | 'attended';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepReport[];
  /**
   * Run-level degradation summary. Present even on success, because a run that
   * worked only by falling down the ladder is the one worth looking at before
   * it becomes a run that did not work.
   */
  degradation: {
    degradedSteps: number;
    weakestRank: number;
    productVersionDrift?: { recordedAgainst: string; ranAgainst: string };
  };
  /** Directory holding the structured log, screenshots and observations. */
  evidencePath: string;
}

export type ReplayResult = ReplayEnvelope &
  (
    | { status: 'success'; outputs: Outputs }
    | {
        status: 'business-outcome';
        outcome: { code: string; title: string; message?: string };
        /** Outputs declared on the outcome, which may be a different set. */
        outputs: Outputs;
      }
    | { status: 'escalated'; escalation: Escalation }
    | { status: 'failed'; failure: Failure }
  );

/**
 * Narrowing helper for callers.
 *
 * Exists to make the common mistake awkward: `if (!isSuccess(r)) throw` reads
 * as obviously wrong when the alternative statuses are right there, whereas
 * `if (!r.ok) throw` reads as reasonable and quietly turns "no such member"
 * into an exception.
 */
export function isSuccess(result: ReplayResult): result is ReplayResult & { status: 'success' } {
  return result.status === 'success';
}
