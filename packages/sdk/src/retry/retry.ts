import { ProviderError } from "../providers/adapter";

// ---------------------------------------------------------------------------
// withRetry — exponential backoff with AbortSignal propagation.
//
// AbortError exits immediately without consuming retry budget.
// onAttemptFailed is used by the router to build FailedAttempt records
// without coupling error-classification logic to this module.
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number; // Default: 200
  maxDelayMs?: number; // Default: 5_000
  jitter?: boolean; // Default: true
  /** Caller-supplied cancellation signal. An abort exits retries immediately. */
  signal?: AbortSignal;
  /**
   * Called before each attempt, outside the try/catch.
   * Throwing here exits the retry loop immediately — the error is not
   * subject to retry logic and onAttemptFailed is not called.
   */
  beforeAttempt?: () => void;
  /** Called after each failed attempt (before deciding whether to retry). */
  onAttemptFailed?: (err: unknown, attempt: number, durationMs: number) => void;
}

export interface RetryResult<T> {
  value: T;
  /** Total number of attempts made (including the successful one). */
  attempts: number;
}

/**
 * Execute fn with exponential backoff retry.
 *
 * Retry conditions:
 *   - ProviderError with isRetryable=true → retry
 *   - ProviderError with isRetryable=false → rethrow immediately
 *   - AbortError (signal fired) → rethrow immediately, no more attempts
 *   - All other errors → retry (conservative default)
 *
 * fn receives the AbortSignal so it can abort in-flight work cleanly.
 */
export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const { maxAttempts, signal } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Bail immediately if the caller has already aborted.
    signal?.throwIfAborted();

    options.beforeAttempt?.();

    const start = Date.now();

    try {
      const value = await fn(signal);
      return { value, attempts: attempt };
    } catch (err) {
      const durationMs = Date.now() - start;
      options.onAttemptFailed?.(err, attempt, durationMs);

      // AbortError — do not retry, propagate immediately.
      if (isAbortError(err)) throw err;

      // Non-retryable ProviderError — propagate immediately.
      if (err instanceof ProviderError && !err.isRetryable) throw err;

      // Last attempt — propagate the error.
      if (attempt >= maxAttempts) throw err;

      // Retryable — wait before next attempt.
      const delay = computeDelay(attempt, options);
      await sleepAbortable(delay, signal);
    }
  }

  // Unreachable — loop always returns or throws.
  throw new Error("withRetry: invariant violation");
}

// ---------------------------------------------------------------------------
// Delay computation
// ---------------------------------------------------------------------------

export function computeDelay(attempt: number, options: RetryOptions): number {
  const base = options.baseDelayMs ?? 200;
  const max = options.maxDelayMs ?? 5_000;
  const exponential = Math.min(base * Math.pow(2, attempt - 1), max);

  if (options.jitter === false) return exponential;

  // ±20% jitter to spread thundering herd
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.round(exponential * jitterFactor);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Sleep for `ms` milliseconds, but abort early if signal fires.
 * Resolves normally on abort (the caller checks signal before the next attempt).
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
