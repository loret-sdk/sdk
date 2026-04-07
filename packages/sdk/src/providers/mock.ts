import type { ProviderCallInput, ProviderCallResult } from "../shared";

import { ProviderError, type ProviderAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// MockProvider — deterministic test double for ProviderAdapter.
// Exported only from @loret/sdk/testing — not from the main entry point.
// ---------------------------------------------------------------------------

export interface MockProviderOptions {
  /** Fixed content returned on success. Default: "mock response" */
  response?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Artificial delay in ms. Default: 0 */
  latencyMs?: number;
  /** Throw a ProviderError for this many calls before succeeding. */
  failTimes?: number;
  /** Always throw. */
  alwaysFail?: boolean;
  errorCode?: string;
  retryable?: boolean;
  /** Override the adapter name. Default: "mock" */
  name?: string;
}

export class MockProvider implements ProviderAdapter {
  readonly name: string;
  private callCount = 0;
  private lastInput: ProviderCallInput | undefined;

  constructor(private readonly opts: MockProviderOptions = {}) {
    this.name = opts.name ?? "mock";
  }

  async call(input: ProviderCallInput, signal?: AbortSignal): Promise<ProviderCallResult> {
    this.callCount++;
    this.lastInput = input;

    signal?.throwIfAborted();

    if (this.opts.latencyMs) {
      await sleepAbortable(this.opts.latencyMs, signal);
    }

    const shouldFail =
      this.opts.alwaysFail ||
      (this.opts.failTimes !== undefined && this.callCount <= this.opts.failTimes);

    if (shouldFail) {
      throw new ProviderError(
        this.opts.errorCode ?? "mock_error",
        `MockProvider failure on call ${this.callCount}`,
        this.opts.retryable ?? true,
      );
    }

    const inputTokens = this.opts.inputTokens ?? 10;
    const outputTokens = this.opts.outputTokens ?? 20;

    return {
      type: "buffered",
      content: this.opts.response ?? "mock response",
      provider: this.name,
      model: input.model,
      usage: {
        inputTokens,
        outputTokens,
        estimatedCostUsd: estimateCost(inputTokens, outputTokens),
      },
      latencyMs: this.opts.latencyMs ?? 0,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  getLastInput(): ProviderCallInput | undefined {
    return this.lastInput;
  }

  reset(): void {
    this.callCount = 0;
    this.lastInput = undefined;
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  // Per-1k-token rates matching SDK nominal fallback: $5/M input, $15/M output.
  return (inputTokens / 1000) * 0.005 + (outputTokens / 1000) * 0.015;
}
