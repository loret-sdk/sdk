// ---------------------------------------------------------------------------
// Provider call contracts — shared between SDK and provider adapter
// implementations. Designed to support both buffered and streaming responses
// without breaking the public API when streaming is introduced.
// ---------------------------------------------------------------------------

export interface Message {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

// ---------------------------------------------------------------------------
// Input — provider-agnostic, built by the router from RunOptions + policy
// ---------------------------------------------------------------------------

export interface ProviderCallInput {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Message[];
  readonly maxTokens?: number;
  readonly timeoutMs: number;
  /** Composed AbortSignal (caller signal + timeout). Respect this to cancel in-flight work. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Result — discriminated union allows streaming support without breaking the
// buffered API path. Phase 1 implementations return "buffered" only.
// ---------------------------------------------------------------------------

export interface BufferedCallResult {
  readonly type: "buffered";
  readonly content: string;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly provider: string;
  readonly model: string;
}

export interface StreamingCallResult {
  readonly type: "streaming";
  readonly stream: AsyncIterable<string>;
  /** Resolves with final usage counts once the stream is fully consumed. */
  readonly usage: Promise<TokenUsage>;
  readonly provider: string;
  readonly model: string;
}

export type ProviderCallResult = BufferedCallResult | StreamingCallResult;
