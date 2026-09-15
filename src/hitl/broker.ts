/**
 * The session broker: who holds the live session, and how it changes hands.
 *
 * One broker owns one session for its whole life. The automation borrows it,
 * hands it to a person when it cannot safely proceed, and takes it back when
 * they are done. The session itself is never recreated -- the human works on
 * the genuine page the automation was stopped on, which is what the brief
 * means by "the same live session, not a fresh one". A handoff that opened a
 * new browser would lose the signed-on session, the half-filled form and the
 * dialog that caused the escalation in the first place, which is to say it
 * would lose everything the person was called in to look at.
 *
 * Three things are worth pointing at.
 *
 * **Exactly one holder, enforced.** Control is a token, and the token is
 * checked inside `act()` (see ./controlled.ts). While a person is working, the
 * automation's token is not the live one, so an executor that resumed early
 * would be refused rather than racing the human for the keyboard. The race is
 * not unlikely, it is unrepresentable.
 *
 * **Waiting is bounded.** A run parked on a human who never arrives is worse
 * than a run that failed, because nothing surfaces and the session leaks. Every
 * intervention carries a deadline, and passing it is an ordinary `expired`
 * resolution rather than an error.
 *
 * **The handover is evidence.** The screen is captured when a person takes
 * control and again when they give it back, both into the same run directory
 * as everything else. That pair is what lets a reviewer see what the human
 * changed without anyone having to trust their account of it -- and it is the
 * honest version of "their actions are captured", given that keystroke-level
 * capture of a remote operator is a transport problem this does not pretend to
 * have solved.
 */

import { randomUUID } from 'node:crypto';
import { NULL_SINK, type EvidenceSink } from '../evidence/types.js';
import type { Observation, Surface } from '../surface/types.js';
import {
  ControlError,
  type ControlState,
  type ControlToken,
  type Disposition,
  type EscalationNotice,
  type Intervention,
  type Resolution,
} from './types.js';

export interface SessionBrokerOptions {
  /** The live session. The broker owns its lifetime from here on. */
  surface: Surface;
  evidence?: EvidenceSink;
  sessionId?: string;
  /** How long an intervention may sit unattended before it expires. */
  defaultTimeoutMs?: number;
  now?: () => Date;
}

interface Pending {
  resolve: (resolution: Resolution) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionBroker {
  readonly sessionId: string;

  private readonly surface: Surface;
  private readonly evidence: EvidenceSink;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => Date;

  private state: ControlState = 'automation';

  /**
   * Stable for the session rather than re-minted on every resume.
   *
   * What has to be true is that the automation cannot act while a person holds
   * the session, and that is a property of the *state*, not of the token's
   * freshness. Keeping the identity stable means the executor is handed one
   * token at the start and never has to re-fetch it -- a re-fetch being a
   * thing code can forget to do, and therefore a way back to the race this
   * exists to remove.
   */
  private readonly automation: ControlToken;
  private operator?: ControlToken;

  private readonly interventions = new Map<string, Intervention>();
  private readonly pending = new Map<string, Pending>();
  /** The intervention currently holding up the run, if any. */
  private open?: string;

  constructor(options: SessionBrokerOptions) {
    this.surface = options.surface;
    this.evidence = options.evidence ?? NULL_SINK;
    this.sessionId = options.sessionId ?? randomUUID();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());

    this.automation = {
      id: randomUUID(),
      holder: 'automation',
      sessionId: this.sessionId,
    };
  }

  get controlState(): ControlState {
    return this.state;
  }

  /** The token the executor is given at the start of the run. */
  get automationToken(): ControlToken {
    return this.automation;
  }

  /**
   * Whether this token may act right now.
   *
   * Both halves matter. The token must be the one issued to its holder, and
   * that holder must be the one the state machine currently favours -- an
   * operator token is real but inert once they have handed back.
   */
  holds(token: ControlToken): boolean {
    if (token.sessionId !== this.sessionId) return false;
    if (this.state === 'automation') return token === this.automation;
    if (this.state === 'human') return token === this.operator;
    return false;
  }

  /** Why an action was refused, phrased for the evidence log. */
  refusalReason(token: ControlToken): string {
    if (token.sessionId !== this.sessionId) {
      return 'That control token belongs to a different session.';
    }
    switch (this.state) {
      case 'awaiting-operator':
        return 'The session is paused waiting for an operator to take control.';
      case 'human':
        return `An operator${this.currentOperator ? ` (${this.currentOperator})` : ''} is working in this session.`;
      case 'closed':
        return 'The session has been closed.';
      default:
        return 'That token is not the current grant for this session.';
    }
  }

  private get currentOperator(): string | undefined {
    return this.open ? this.interventions.get(this.open)?.operator : undefined;
  }

  // -------------------------------------------------------------------------
  // automation -> awaiting-operator
  // -------------------------------------------------------------------------

  /**
   * Stops the run and asks for a person.
   *
   * Control is surrendered here, not when the operator arrives. The gap
   * between "we decided we need a human" and "a human is present" is the
   * window in which a retry loop somewhere would otherwise keep acting on a
   * screen the system has already admitted it does not understand.
   */
  async raise(notice: EscalationNotice): Promise<Intervention> {
    if (this.state === 'closed') throw new ControlError('The session is closed.');
    if (this.state !== 'automation') {
      throw new ControlError(`Cannot escalate from state "${this.state}".`);
    }

    const at = this.now().toISOString();
    const where = await this.look();

    const intervention: Intervention = {
      id: randomUUID(),
      sessionId: this.sessionId,
      runId: notice.runId,
      capabilityId: notice.capabilityId,
      reason: notice.reason,
      message: notice.message,
      raisedAt: at,
      location: where?.location ?? '',
      title: where?.title ?? '',
      state: 'waiting',
      ...(notice.stepId ? { stepId: notice.stepId } : {}),
      ...(notice.intent ? { intent: notice.intent } : {}),
      ...(notice.screenshotPath ? { screenshotPath: notice.screenshotPath } : {}),
      ...(notice.observationPath ? { observationPath: notice.observationPath } : {}),
    };

    this.interventions.set(intervention.id, intervention);
    this.open = intervention.id;
    this.state = 'awaiting-operator';

    await this.evidence.event({
      at,
      kind: 'control.escalated',
      sessionId: this.sessionId,
      interventionId: intervention.id,
      runId: notice.runId,
      reason: notice.reason,
      message: notice.message,
      stepId: notice.stepId,
      location: intervention.location,
    });

    return intervention;
  }

  /**
   * Blocks the run until a person deals with it, or until the deadline.
   *
   * Expiry resolves the intervention rather than rejecting, so the executor
   * has one code path for "a human dealt with this" and no separate one for
   * "a human did not" -- the disposition already distinguishes them, and a
   * thrown timeout would make the caller reconstruct that from a catch block.
   */
  waitForResolution(interventionId: string, opts: { timeoutMs?: number } = {}): Promise<Resolution> {
    const intervention = this.require(interventionId);

    if (intervention.state === 'resolved') {
      return Promise.resolve(this.resolutionOf(intervention));
    }

    return new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(interventionId);
        void this.settle(interventionId, 'expired', undefined, 'No operator took control before the deadline.').then(
          () => resolve(this.resolutionOf(this.require(interventionId))),
        );
      }, opts.timeoutMs ?? this.defaultTimeoutMs);

      // Node keeps the process alive for a pending timer, which would hold a
      // CLI open long after the run it was waiting on has been answered.
      timer.unref?.();

      this.pending.set(interventionId, { resolve, timer });
    });
  }

  // -------------------------------------------------------------------------
  // awaiting-operator -> human
  // -------------------------------------------------------------------------

  /**
   * A person takes the session.
   *
   * Returns their own token. It is a different object from the automation's,
   * so nothing that was written to drive the run can act through it by
   * accident, and the evidence log can say which of the two did a thing.
   */
  async attach(interventionId: string, operator: string): Promise<ControlToken> {
    const intervention = this.require(interventionId);

    if (intervention.state === 'resolved') {
      throw new ControlError(`Intervention ${interventionId} has already been resolved.`);
    }
    if (intervention.state === 'attached') {
      throw new ControlError(`Intervention ${interventionId} is already being worked by ${intervention.operator}.`);
    }

    const at = this.now().toISOString();
    intervention.state = 'attached';
    intervention.operator = operator;
    intervention.attachedAt = at;

    this.operator = { id: randomUUID(), holder: 'operator', sessionId: this.sessionId };
    this.state = 'human';

    // The "before" half of the pair. Captured after the state flips, so the
    // screen recorded as the operator's starting point is one the automation
    // is already locked out of.
    await this.capture(`intervention-${short(interventionId)}-handover`);

    await this.evidence.event({
      at,
      kind: 'control.granted',
      sessionId: this.sessionId,
      interventionId,
      holder: 'operator',
      operator,
    });

    return this.operator;
  }

  /** The live session, for an operator front end to drive or display. */
  get liveSurface(): Surface {
    return this.surface;
  }

  // -------------------------------------------------------------------------
  // human -> automation, or closed
  // -------------------------------------------------------------------------

  /**
   * The person is done. Control returns to the automation, which does not
   * take their word for it -- the executor re-checks the step's condition
   * before carrying on (see the resume path in src/replay/execute.ts).
   */
  async resolve(
    interventionId: string,
    disposition: Disposition,
    opts: { operator?: string; note?: string } = {},
  ): Promise<Resolution> {
    const intervention = this.require(interventionId);
    if (intervention.state === 'resolved') {
      throw new ControlError(`Intervention ${interventionId} has already been resolved.`);
    }

    return this.settle(interventionId, disposition, opts.operator, opts.note);
  }

  private async settle(
    interventionId: string,
    disposition: Disposition,
    operator: string | undefined,
    note: string | undefined,
  ): Promise<Resolution> {
    const intervention = this.require(interventionId);
    if (intervention.state === 'resolved') return this.resolutionOf(intervention);

    const at = this.now().toISOString();
    const wasAttached = intervention.state === 'attached';

    intervention.state = 'resolved';
    intervention.resolvedAt = at;
    intervention.disposition = disposition;
    if (operator) intervention.operator = operator;
    if (note) intervention.note = note;

    // The "after" half. Only meaningful if somebody actually had the session:
    // an expired intervention nobody attached to has an unchanged screen, and
    // a second identical capture would just be noise in the directory.
    if (wasAttached) {
      const after = await this.capture(`intervention-${short(interventionId)}-returned`);
      if (after) {
        intervention.location = after.location;
        intervention.title = after.title;
      }
    }

    this.operator = undefined;
    this.open = undefined;
    this.state = disposition === 'abandoned' ? 'closed' : 'automation';

    await this.evidence.event({
      at,
      kind: 'control.returned',
      sessionId: this.sessionId,
      interventionId,
      disposition,
      operator: intervention.operator,
      note: intervention.note,
      holder: this.state === 'closed' ? 'none' : 'automation',
      location: intervention.location,
    });

    const resolution = this.resolutionOf(intervention);

    const waiter = this.pending.get(interventionId);
    if (waiter) {
      this.pending.delete(interventionId);
      clearTimeout(waiter.timer);
      waiter.resolve(resolution);
    }

    return resolution;
  }

  // -------------------------------------------------------------------------
  // The operator console's view
  // -------------------------------------------------------------------------

  /** Everything still wanting a person, oldest first. */
  waiting(): Intervention[] {
    return [...this.interventions.values()]
      .filter((i) => i.state !== 'resolved')
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  }

  all(): Intervention[] {
    return [...this.interventions.values()].sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  }

  get(interventionId: string): Intervention | undefined {
    return this.interventions.get(interventionId);
  }

  /** Ends the session. Any run still waiting is released as `abandoned`. */
  async close(): Promise<void> {
    for (const intervention of this.waiting()) {
      await this.settle(intervention.id, 'abandoned', undefined, 'The session was closed.');
    }
    this.state = 'closed';
    await this.surface.close();
  }

  // -------------------------------------------------------------------------

  private require(interventionId: string): Intervention {
    const intervention = this.interventions.get(interventionId);
    if (!intervention) throw new ControlError(`No intervention "${interventionId}" in this session.`);
    return intervention;
  }

  private resolutionOf(intervention: Intervention): Resolution {
    return {
      interventionId: intervention.id,
      sessionId: this.sessionId,
      disposition: intervention.disposition ?? 'expired',
      ...(intervention.operator ? { operator: intervention.operator } : {}),
      ...(intervention.note ? { note: intervention.note } : {}),
    };
  }

  /**
   * Observing never needs the token, here or in ControlledSurface: looking at
   * a screen changes nothing, and the moments worth recording are exactly the
   * ones where control is in flight.
   */
  private async look(): Promise<Observation | undefined> {
    return this.surface.observe().catch(() => undefined);
  }

  private async capture(name: string): Promise<Observation | undefined> {
    const observation = await this.surface.observe({ screenshot: true }).catch(() => undefined);
    if (!observation) return undefined;

    if (observation.screenshot) {
      await this.evidence.screenshot(name, observation.screenshot).catch(() => '');
    }
    await this.evidence.observation(name, observation).catch(() => '');
    return observation;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
