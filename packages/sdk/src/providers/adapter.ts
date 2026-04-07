import type { ProviderCallInput, ProviderCallResult } from "../shared";

// ---------------------------------------------------------------------------
// ProviderAdapter — stateless I/O wrapper contract.
//
// The name field is an open string so consumers can register custom adapters
// without modifying SDK internals. All retry, timeout, circuit breaking,
// and telemetry happen above this layer in the router.
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /**
   * Open string identifier. Must be unique within a ProviderRegistry.
   * Matches the `provider` field in ProviderTarget (from policy).
   * Examples: "openai", "anthropic", "azure-openai", "my-custom-llm"
   */
  readonly name: string;

  /**
   * Execute a single inference call.
   *
   * Implementations must:
   * - Respect the signal (abort ongoing fetch when signal fires)
   * - Map provider-specific errors to ProviderError
   * - Not implement retry — that is the caller's responsibility
   * - Return either a BufferedCallResult or StreamingCallResult
   */
  call(input: ProviderCallInput, signal?: AbortSignal): Promise<ProviderCallResult>;
}

// ---------------------------------------------------------------------------
// ProviderError — structured error from a single adapter call.
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly isRetryable: boolean = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
