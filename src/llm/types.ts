/**
 * The model seam.
 *
 * The discovery loop talks to this interface and nothing else, which is what
 * makes two otherwise awkward things easy: swapping providers without touching
 * the loop, and testing the loop deterministically against a scripted mock. The
 * brief allows most things to be stubbed at "a clean, documented seam" -- this
 * is the seam that matters most, because it is the one the loop is built on.
 *
 * The shape is tool calls, not free text. A loop that asks for prose and parses
 * it is a loop that spends most of its code recovering from prose, and every
 * recovery is a guess about what the model meant. Constraining output to a tool
 * schema moves that problem to the provider, where it is the provider's
 * grammar-constrained decoder solving it rather than our regex.
 */

/** A JSON Schema object describing one callable action. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Set when the model emitted arguments that were not valid JSON.
   *
   * This is a message to the model, not an exception: the loop feeds the parse
   * error back as a tool result so the model can correct itself. Throwing here
   * would turn a recoverable mistake into a dead run.
   */
  malformed?: string;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: ToolSchema[];
  /** Require the model to call a tool rather than answer in prose. */
  requireTool?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  /** Any prose the model produced alongside its tool calls. */
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: LlmUsage;
  /** Wall-clock time for the call, recorded into evidence. */
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}
