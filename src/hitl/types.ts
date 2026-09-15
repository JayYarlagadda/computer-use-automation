/**
 * Control transfer vocabulary.
 *
 * The brief asks who is (or should be) in control of a session, and treats
 * that as a design question rather than a convention. A convention -- "the
 * automation promises not to act while a human is working" -- cannot answer
 * it, because nothing enforces a promise and nothing can report on one.
 *
 * So control is a typed state machine with exactly one holder at a time, and
 * the holder carries a token that `act()` requires. An action attempted
 * without the live token is refused the same way a policy violation is: as a
 * typed value, with a code, in the evidence log.
 */

import type { EscalationReason } from '../artifact/result.js';

/**
 * Who may act right now.
 *
 * `awaiting-operator` is a real state rather than a flavour of `human`,
 * because "stopped, and nobody has picked it up" is the condition an operator
 * console exists to show. Collapsing it into `human` would make a run that
 * nobody has noticed look identical to one being actively worked.
 */
export type ControlState = 'automation' | 'awaiting-operator' | 'human' | 'closed';

export type Holder = 'automation' | 'operator';

/**
 * Proof that the bearer is the current holder of a session.
 *
 * Opaque and compared by identity. It is not a credential -- everything here
 * runs in one process -- it is a *capability* in the object sense: holding one
 * is the only way to act, so a component that was never given one cannot act
 * even by mistake.
 */
export interface ControlToken {
  readonly id: string;
  readonly holder: Holder;
  readonly sessionId: string;
}

/**
 * What the human decided.
 *
 * Note what is absent: there is no "approved, now you do it". An irreversible
 * step that needs a person is performed *by* that person, in the live session,
 * and the executor then re-verifies. The alternative -- a grant the choke
 * point honours -- would introduce the one thing the choke point exists to
 * make impossible, a way for automation to perform an irreversible action
 * without a human at the controls. Requiring the approver to also be the actor
 * keeps the action attributable to a named person, which is the property a
 * bank's audit actually wants.
 */
export type Disposition =
  /** The operator did the work in the live session. Re-verify and carry on. */
  | 'completed'
  /** The operator looked and decided the run must not proceed. */
  | 'rejected'
  /** Nobody attached before the intervention's deadline. */
  | 'expired'
  /** The operator ended the session entirely. */
  | 'abandoned';

/** Whether a resolved intervention lets the run continue. */
export function resumes(disposition: Disposition): boolean {
  return disposition === 'completed';
}

export type InterventionState = 'waiting' | 'attached' | 'resolved';

/**
 * One request for a human, and everything they need to act on it.
 *
 * This is the record an operator console renders. It deliberately carries the
 * evidence paths rather than the observation itself: the console shows a
 * screenshot and a link, and the full perception stays in the run directory
 * where it is already redacted.
 */
export interface Intervention {
  id: string;
  sessionId: string;
  runId: string;
  capabilityId: string;
  reason: EscalationReason;
  /** Written for the person, not for a log: what is being asked of them. */
  message: string;
  stepId?: string;
  /** What the step was trying to achieve, so the operator can finish it. */
  intent?: string;
  raisedAt: string;
  /** Where the run stopped, for an operator deciding whether to attach. */
  location: string;
  title: string;
  screenshotPath?: string;
  observationPath?: string;

  state: InterventionState;
  operator?: string;
  attachedAt?: string;
  resolvedAt?: string;
  disposition?: Disposition;
  /** The operator's account of what they did. Goes into evidence. */
  note?: string;
}

/** What the broker tells a waiting executor once a person has dealt with it. */
export interface Resolution {
  interventionId: string;
  sessionId: string;
  disposition: Disposition;
  operator?: string;
  note?: string;
}

/** Raised by the executor; everything the broker needs to open an intervention. */
export interface EscalationNotice {
  runId: string;
  capabilityId: string;
  reason: EscalationReason;
  message: string;
  stepId?: string;
  intent?: string;
  screenshotPath?: string;
  observationPath?: string;
}

/**
 * Thrown only for genuine programming errors -- attaching to an intervention
 * that does not exist, resolving one twice. A human arriving too late is not
 * one of those; that is an ordinary `expired` resolution.
 */
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlError';
  }
}
