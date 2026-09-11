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

const armed = new Map<FaultKind, ArmedFault>();

export function armFault(kind: FaultKind, count = 1, delayMs?: number): void {
  armed.set(kind, { kind, remaining: count, delayMs });
}

export function clearFaults(): void {
  armed.clear();
}

export function listFaults(): ArmedFault[] {
  return [...armed.values()];
}

/**
 * Returns true if this fault should fire now, decrementing its budget.
 * Consuming on read is what makes transient faults self-healing.
 */
export function consumeFault(kind: FaultKind): ArmedFault | undefined {
  const f = armed.get(kind);
  if (!f || f.remaining <= 0) return undefined;
  f.remaining -= 1;
  if (f.remaining <= 0) armed.delete(kind);
  return f;
}
