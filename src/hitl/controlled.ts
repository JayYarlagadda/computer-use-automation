/**
 * A session you can only act on while you hold control.
 *
 * `Surface.act()` is already the one function every action in both discovery
 * and replay passes through (D4), which makes it the only honest place to ask
 * "should you be doing that right now". This wrapper adds that question in
 * front of the policy check, so the ordering is: are you in control, then are
 * you allowed. Both answers are typed values rather than exceptions, for the
 * same reason -- the caller has to carry on afterwards either way.
 *
 * Two deliberate asymmetries.
 *
 * **Observing is never gated.** Watching a screen changes nothing, and the
 * moments most worth recording are the ones where a human has the session.
 * Gating perception would blind the evidence log exactly when it matters and
 * would stop the executor from re-verifying the step after a handback, which
 * is the whole reason the handback is trustworthy.
 *
 * **Closing is not delegated.** The session outlives any one holder, so a
 * component that merely borrowed it does not get to end it. The broker owns
 * that, and `SessionBroker.close()` is the only way through.
 */

import type { Action, ActResult, Observation, Surface } from '../surface/types.js';
import type { SessionBroker } from './broker.js';
import type { ControlToken } from './types.js';

/** Refusal code for an action attempted without the live token. */
export const NOT_IN_CONTROL = 'NOT_IN_CONTROL';

export function controlledSurface(
  surface: Surface,
  broker: SessionBroker,
  token: ControlToken,
): Surface {
  return {
    kind: surface.kind,

    observe(opts?: { screenshot?: boolean }): Promise<Observation> {
      return surface.observe(opts);
    },

    async act(action: Action): Promise<ActResult> {
      if (!broker.holds(token)) {
        const reason = broker.refusalReason(token);
        return {
          ok: false,
          error: reason,
          refusal: {
            // `denied`, not `approval-required`: this is not a request that a
            // person could grant from here. Control has already moved, and the
            // caller's job is to stop rather than to ask again.
            kind: 'denied',
            code: NOT_IN_CONTROL,
            reason,
            // Assessing the risk of an action we are refusing to look at would
            // mean running the classifier on behalf of a caller that has no
            // standing to perform it at all.
            risk: 'safe',
          },
        };
      }

      return surface.act(action);
    },

    async close(): Promise<void> {
      // Intentionally inert. See the module comment: the broker owns the
      // session's lifetime because more than one holder borrows it.
    },
  };
}
