/**
 * Provider for any OpenAI-wire-compatible endpoint, which is what Groq serves.
 *
 * Groq is not a fourth SDK to learn; it is the OpenAI client pointed at a
 * different base URL. Writing this as "OpenAI-compatible" rather than "Groq"
 * costs nothing today and means OpenAI itself, Together, Fireworks, vLLM or a
 * local Ollama are all a base URL away -- which is the honest answer to "does
 * this generalise across providers" rather than a claim in a README.
 */

import OpenAI from 'openai';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, ToolCall } from './types.js';
import { LlmError } from './types.js';

export interface OpenAiCompatibleOptions {
  name: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Total attempts including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Reasoning models accept this; ignored by those that do not. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const maxAttempts = options.maxAttempts ?? 4;

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs ?? 90_000,
    // Retries are handled here rather than by the SDK so that the backoff is
    // visible in evidence and so a caller's AbortSignal is honoured between
    // attempts instead of only within one.
    maxRetries: 0,
  });

  return {
    name: options.name,
    model: options.model,

    async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const startedAt = Date.now();
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        try {
          const completion = await client.chat.completions.create(
            {
              model: options.model,
              messages: request.messages.map(toWireMessage),
              temperature: request.temperature ?? 0,
              max_completion_tokens: request.maxTokens ?? 2048,
              ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
              ...(request.tools?.length
                ? {
                    tools: request.tools.map((tool) => ({
                      type: 'function' as const,
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                      },
                    })),
                    tool_choice: request.requireTool ? ('required' as const) : ('auto' as const),
                    // The discovery loop wants one deliberate action per turn.
                    // Parallel calls would let the model fire a click and a
                    // read at once, and the read would race the navigation the
                    // click triggered.
                    parallel_tool_calls: false,
                  }
                : {}),
            },
            { signal },
          );

          const choice = completion.choices[0];
          if (!choice) throw new LlmError('Provider returned no choices', { retryable: true });

          return {
            text: choice.message.content ?? '',
            toolCalls: (choice.message.tool_calls ?? []).flatMap(readToolCall),
            finishReason: choice.finish_reason ?? 'unknown',
            usage: completion.usage
              ? {
                  promptTokens: completion.usage.prompt_tokens,
                  completionTokens: completion.usage.completion_tokens,
                  totalTokens: completion.usage.total_tokens,
                }
              : undefined,
            latencyMs: Date.now() - startedAt,
          };
        } catch (error) {
          lastError = error;
          const failure = classify(error);
          if (!failure.retryable || attempt === maxAttempts) throw failure;
          await sleep(backoffMs(attempt, error), signal);
        }
      }

      throw classify(lastError);
    },
  };
}

function toWireMessage(message: LlmMessage): OpenAI.Chat.ChatCompletionMessageParam {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content ?? '',
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      };
  }
}

function readToolCall(raw: OpenAI.Chat.ChatCompletionMessageToolCall): ToolCall[] {
  if (raw.type !== 'function') return [];
  const { name, arguments: args } = raw.function;

  try {
    const parsed: unknown = args ? JSON.parse(args) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [{ id: raw.id, name, arguments: {}, malformed: 'arguments must be a JSON object' }];
    }
    return [{ id: raw.id, name, arguments: parsed as Record<string, unknown> }];
  } catch (error) {
    return [
      {
        id: raw.id,
        name,
        arguments: {},
        malformed: error instanceof Error ? error.message : 'unparseable arguments',
      },
    ];
  }
}

function classify(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    return new LlmError(`Provider returned ${status ?? 'an error'}: ${error.message}`, {
      // A 401 or a 404 on the model id will fail identically forever; retrying
      // only delays a message the operator needs to see now.
      retryable: status === undefined || RETRYABLE_STATUS.has(status),
      status,
      cause: error,
    });
  }

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new LlmError(`Provider call ${error.name === 'AbortError' ? 'aborted' : 'timed out'}`, {
      retryable: error.name === 'TimeoutError',
      cause: error,
    });
  }

  return new LlmError(error instanceof Error ? error.message : String(error), {
    retryable: true,
    cause: error,
  });
}

/** Exponential backoff with jitter, capped, honouring Retry-After when sent. */
function backoffMs(attempt: number, error: unknown): number {
  if (error instanceof OpenAI.APIError) {
    const header = error.headers?.get?.('retry-after');
    const seconds = header ? Number(header) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.random() * 250;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
