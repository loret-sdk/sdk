import type { ProviderTarget, ProviderCallInput, ProviderCallResult, PolicyMode } from "../shared";
import type { FailedAttempt } from "../shared";

import type { ProviderRegistry } from "../providers/registry";
import type { CircuitBreakerRegistry } from "../guardrails/circuit-breaker";
import { checkTraceGuard } from "../guardrails/trace-guard";
import type { TraceGuardLimits, TraceGuardState } from "../guardrails/trace-guard";
import { ProviderError } from "../providers/adapter";
import { withRetry } from "../retry/retry";
import { AllProvidersFailedError, ProviderTimeoutError, TraceGuardExceededError } from "../errors";

// Circuit breaker state management is fully delegated to CircuitBreakerRegistry.
// Retry logic is fully delegated to withRetry().

export interface RouterOptions {
  registry: ProviderRegistry;
  breakers: CircuitBreakerRegistry;
}

export interface RouteRequest {
  /** Provider-agnostic call input (provider/model fields will be set per target). */
  base: Omit<ProviderCallInput, "provider" | "model">;
  /** Ordered targets from PolicySnapshot. Router filters and sorts internally. */
  targets: readonly ProviderTarget[];
  maxRetries: number;
  /** Caller-supplied cancellation signal — propagated to every adapter call. */
  signal?: AbortSignal;
  /** Trace-level guardrails checked before every dispatch attempt. */
  traceGuard?: {
    readonly limits: TraceGuardLimits;
    readonly state: TraceGuardState;
    /** Estimated USD cost for one attempt — used to accumulate trace cost. */
    readonly estimatedCostUsdPerCall: number;
    /** Policy mode: "enforce" throws on violation; "monitor" notes it in state and allows. */
    readonly mode: PolicyMode;
  };
}

export interface RouteResult {
  result: ProviderCallResult;
  provider: string;
  model: string;
  usedFallback: boolean;
  totalAttempts: number;
}

export class ProviderRouter {
  private readonly registry: ProviderRegistry;
  private readonly breakers: CircuitBreakerRegistry;

  constructor(options: RouterOptions) {
    this.registry = options.registry;
    this.breakers = options.breakers;
  }

  // -------------------------------------------------------------------------
  // Main routing entry point
  // -------------------------------------------------------------------------

  async route(req: RouteRequest): Promise<RouteResult> {
    // Abort immediately if signal already fired before we start.
    req.signal?.throwIfAborted();

    const chain = this.buildChain(req.targets);
    if (chain.length === 0) {
      throw new AllProvidersFailedError([]);
    }

    const failedAttempts: FailedAttempt[] = [];
    let attemptNumber = 0;
    let chainIndex = 0;

    for (const target of chain) {
      // Register provider with breaker on first encounter.
      this.breakers.register(target.provider);

      if (this.breakers.isOpen(target.provider)) {
        // Treat an open circuit as a non-retryable skip — record as a failed attempt.
        failedAttempts.push({
          provider: target.provider,
          model: target.model,
          attemptNumber: ++attemptNumber,
          errorCode: "CIRCUIT_OPEN",
          errorMessage: `Circuit breaker open for provider "${target.provider}"`,
          isRetryable: false,
          durationMs: 0,
        });
        chainIndex++;
        continue;
      }

      const input: ProviderCallInput = {
        ...req.base,
        provider: target.provider,
        model: target.model,
      };

      // beforeAttempt is called outside withRetry's try/catch so a trace guard
      // violation propagates immediately without triggering retry logic.
      const beforeAttempt = req.traceGuard
        ? () => {
            const r = checkTraceGuard(
              req.traceGuard!.state,
              req.traceGuard!.limits,
              req.traceGuard!.estimatedCostUsdPerCall,
            );
            if (!r.allowed) {
              if (req.traceGuard!.mode === "enforce") {
                throw new TraceGuardExceededError(r.dimension, r.reason);
              }
              // monitor mode: note violation in state, allow attempt to proceed
              req.traceGuard!.state.monitoredViolation = r;
            }
          }
        : undefined;

      try {
        const { value: result } = await withRetry(
          (signal) => this.dispatch(input, signal),
          {
            maxAttempts: req.maxRetries + 1,
            signal: req.signal,
            beforeAttempt,
            onAttemptFailed: (err, attempt, durationMs) => {
              failedAttempts.push(recordAttempt(target, ++attemptNumber, err, attempt, durationMs));
            },
          },
        );

        this.breakers.recordSuccess(target.provider);

        return {
          result,
          provider: target.provider,
          model: target.model,
          usedFallback: chainIndex > 0,
          // attemptNumber = failed calls across all providers (via onAttemptFailed)
          // +1 = the current successful call (not counted by onAttemptFailed)
          totalAttempts: attemptNumber + 1,
        };
      } catch (err) {
        // Trace guard violations and abort signals terminate routing immediately.
        // Do not record a circuit breaker failure for calls that were never dispatched.
        if (err instanceof TraceGuardExceededError) throw err;
        if (isAbortError(err)) throw err;
        this.breakers.recordFailure(target.provider);
        // failedAttempts already populated by onAttemptFailed above.
      }

      chainIndex++;
    }

    throw new AllProvidersFailedError(failedAttempts);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildChain(targets: readonly ProviderTarget[]): ProviderTarget[] {
    return targets
      .filter((t) => t.isActive && this.registry.has(t.provider))
      .sort((a, b) => a.priority - b.priority);
  }

  /** Dispatch one call with a composed timeout + caller abort signal. */
  private async dispatch(
    input: ProviderCallInput,
    signal?: AbortSignal,
  ): Promise<ProviderCallResult> {
    const adapter = this.registry.getOrThrow(input.provider);

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(new ProviderTimeoutError(input.provider, input.timeoutMs)),
      input.timeoutMs,
    );

    // Compose the caller signal with the timeout signal.
    const composed = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      // Signal is included in input so adapter implementations can read it from either
      // the input object or the second parameter — both carry the same composed signal.
      return await adapter.call({ ...input, signal: composed }, composed);
    } catch (err) {
      if (timeoutController.signal.aborted) {
        throw new ProviderTimeoutError(input.provider, input.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function recordAttempt(
  target: ProviderTarget,
  attemptNumber: number,
  err: unknown,
  _retryAttempt: number,
  durationMs: number,
): FailedAttempt {
  const isProviderError = err instanceof ProviderError;
  return {
    provider: target.provider,
    model: target.model,
    attemptNumber,
    errorCode: isProviderError ? err.code : "UNKNOWN",
    errorMessage: err instanceof Error ? err.message : String(err),
    isRetryable: isProviderError ? err.isRetryable : false,
    durationMs,
  };
}
