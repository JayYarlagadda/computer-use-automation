/**
 * Providers that do not need a network.
 *
 * Two of them, for two different jobs.
 *
 * `createScriptedProvider` returns responses a test wrote by hand. It is how
 * the loop's branches get exercised -- the model that asks to click something
 * outside the allowlist, the model that emits malformed arguments, the model
 * that never converges -- none of which a real provider can be relied upon to
 * produce on demand.
 *
 * `createRecordedProvider` replays a transcript captured from a real run. This
 * is the more interesting one: it means the loop can be tested against output a
 * real model actually produced, in CI, with no key and no spend. A recorded
 * transcript is checked in as evidence anyway, so the test data is a by-product
 * of the run the brief already requires.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';
import { LlmError } from './types.js';

export interface ScriptedProvider extends LlmProvider {
  /** Every request the loop made, in order, for assertions. */
  readonly requests: readonly LlmRequest[];
  readonly callCount: number;
}

export type Script =
  | Array<Partial<LlmResponse>>
  | ((request: LlmRequest, index: number) => Partial<LlmResponse>);

export function createScriptedProvider(script: Script, name = 'scripted'): ScriptedProvider {
  const requests: LlmRequest[] = [];
  let index = 0;

  return {
    name,
    model: 'scripted',
    get requests() {
      return requests;
    },
    get callCount() {
      return index;
    },

    async complete(request: LlmRequest): Promise<LlmResponse> {
      requests.push(request);
      const step = index++;

      const next = typeof script === 'function' ? script(request, step) : script[step];
      if (!next) {
        // Silently returning an empty response here would show up much later as
        // a confusing loop timeout, so fail where the cause is obvious.
        throw new LlmError(`Scripted provider exhausted after ${step} calls`, { retryable: false });
      }

      return fill(next);
    },
  };
}

/** One turn of a captured transcript, as written into evidence. */
export interface RecordedTurn {
  response: Partial<LlmResponse>;
}

export function createRecordedProvider(turns: RecordedTurn[], name = 'recorded'): ScriptedProvider {
  return createScriptedProvider(
    turns.map((turn) => turn.response),
    name,
  );
}

function fill(partial: Partial<LlmResponse>): LlmResponse {
  return {
    text: partial.text ?? '',
    toolCalls: partial.toolCalls ?? [],
    finishReason: partial.finishReason ?? (partial.toolCalls?.length ? 'tool_calls' : 'stop'),
    usage: partial.usage,
    latencyMs: partial.latencyMs ?? 0,
  };
}
