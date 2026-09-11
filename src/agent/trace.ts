/**
 * What a discovery run leaves behind.
 *
 * The trace is the input to the compiler, so it holds more than a log would:
 * each step keeps the node that was acted on and the observations either side
 * of the action. The compiler needs the *before* observation to rank locator
 * strategies -- whether a name is unique on that screen is what decides
 * `role-name` versus `anchor` -- and the *after* observation to synthesise a
 * checkpoint from text that actually appeared.
 *
 * These observations are in-memory only. What reaches disk is the redacted
 * JSONL log the evidence sink writes as the run proceeds.
 */

import type { Action, ActRefusal, Observation, UiNode } from '../surface/types.js';
import type { LlmUsage } from '../llm/types.js';
import type { DeclaredOutput } from './tools.js';
import type { GoalInput } from './prompt.js';

export interface TraceStep {
  index: number;
  turn: number;
  /** The model's stated reason. Becomes the compiled step's `intent`. */
  why: string;
  action: Action;
  /** The node acted on, as perceived. Absent for press/navigate/wait. */
  node?: UiNode;
  observationBefore: Observation;
  /** Filled in on the following turn, from that turn's observation. */
  observationAfter?: Observation;
  ok: boolean;
  refusal?: ActRefusal;
  error?: string;
  /** True when the screen was indistinguishable afterwards. */
  noChange?: boolean;
  screenshotPath?: string;
}

export type DiscoveryFailureCode =
  | 'TURN_BUDGET_EXHAUSTED'
  | 'TIME_BUDGET_EXHAUSTED'
  | 'NO_PROGRESS'
  | 'MODEL_INCOHERENT'
  | 'PROVIDER_ERROR'
  | 'SURFACE_ERROR'
  | 'ABORTED';

export type DiscoveryStatus =
  | 'succeeded'
  | 'business-outcome'
  | 'escalated'
  | 'abandoned'
  | 'failed';

export interface DiscoverySuccess {
  summary: string;
  successText: string;
  outputs: DeclaredOutput[];
  /** The screen the goal was achieved on. The compiler extracts from this. */
  finalObservation: Observation;
}

export interface DiscoveredOutcome {
  code: string;
  title: string;
  description: string;
  evidenceText: string;
  finalObservation: Observation;
}

export interface DiscoveryRun {
  runId: string;
  status: DiscoveryStatus;
  goal: string;
  inputs: GoalInput[];
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  turns: number;
  steps: TraceStep[];
  model: { provider: string; model: string; promptVersion: string };
  usage: LlmUsage;
  evidencePath?: string;

  success?: DiscoverySuccess;
  outcome?: DiscoveredOutcome;
  escalation?: { reason: string };
  abandonment?: { reason: string };
  failure?: { code: DiscoveryFailureCode; message: string };
}

/** Steps worth compiling: the ones that happened and changed something. */
export function effectiveSteps(run: DiscoveryRun): TraceStep[] {
  return run.steps.filter((step) => step.ok && !step.refusal);
}
