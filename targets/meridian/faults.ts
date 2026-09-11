/**
 * Fault injection.
 *
 * The brief is explicit that the interesting replay failures are not layout
 * drift -- they are the runtime conditions that legitimately occur in
 * production: validation errors, "record not found", permission denials,
 * surprise dialogs, session expiry, transient slowness, and outright app
 * errors.
 *
 * You cannot ask a third-party site to deny you permission on demand, which is
 * a large part of why the target app is local (see docs/DECISIONS.md, D6).
 * Arming a fault here lets the replay demo reproduce each of those states
 * deterministically, so the error taxonomy can be *shown* rather than claimed.
 *
 * Faults are armed with a count and consumed as they fire, so "the next
 * request fails, then recovers" -- a transient -- is expressible, which is
 * what a retry policy actually has to be tested against.
 */

export type FaultKind =
  /** Session cookie is rejected; the app bounces back to sign-on. */
  | 'session_expired'
  /** A 500-equivalent error screen. */
  | 'app_error'
  /** Transient slowness, to exercise waits rather than fixed sleeps. */
  | 'slow'
  /** An unexpected notice screen appears before the intended page. */
  | 'interstitial'
  /** Entitlement failure regardless of which member was requested. */
  | 'permission_denied';

interface ArmedFault {
  kind: FaultKind;
  /** How many more requests this fault should affect. */
  remaining: number;
  /** Only used by 'slow'. */
  delayMs?: number;
}

/**
 * Armed faults are held per running instance rather than per module, so two
 * tenants can run in one process without arming each other's faults. The
 * cross-tenant tests depend on that isolation.
 */
export class FaultBox {
  private readonly armed = new Map<FaultKind, ArmedFault>();

  arm(kind: FaultKind, count = 1, delayMs?: number): void {
    this.armed.set(kind, { kind, remaining: count, delayMs });
  }

  clear(): void {
    this.armed.clear();
  }

  list(): ArmedFault[] {
    return [...this.armed.values()];
  }

  /**
   * Returns the fault if it should fire now, decrementing its budget.
   * Consuming on read is what makes transient faults self-healing.
   */
  consume(kind: FaultKind): ArmedFault | undefined {
    const f = this.armed.get(kind);
    if (!f || f.remaining <= 0) return undefined;
    f.remaining -= 1;
    if (f.remaining <= 0) this.armed.delete(kind);
    return f;
  }
}
