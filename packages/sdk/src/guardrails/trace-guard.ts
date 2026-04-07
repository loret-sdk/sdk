import type { TraceGuards } from "../shared";

import { InvalidTraceGuardConfigError } from "../errors";

// ---------------------------------------------------------------------------
// Trace-level guardrails — max calls, max cost, max duration per run().
//
// State is created once per run() call and threaded through the router so
// every attempt (retries + fallbacks) shares the same counters.
//
// checkTraceGuard() is called before every provider dispatch — synchronous,
// no allocations beyond the state struct, no network I/O.
// ---------------------------------------------------------------------------

export type { TraceGuards as TraceGuardLimits };

export interface TraceGuardState {
  callCount: number;
  totalEstimatedCostUsd: number;
  readonly startedAt: number;
  /** Set when a violation occurs in monitor mode. Cleared on the next allowed attempt. */
  monitoredViolation?: TraceGuardViolation;
}

export type TraceGuardDimension = "calls" | "cost" | "duration";

export interface TraceGuardViolation {
  readonly allowed: false;
  readonly reason: string;
  readonly dimension: TraceGuardDimension;
}

export type TraceGuardCheckResult = { readonly allowed: true } | TraceGuardViolation;

export function newTraceGuardState(): TraceGuardState {
  return { callCount: 0, totalEstimatedCostUsd: 0, startedAt: Date.now() };
}

/**
 * Validate trace guard limits at configuration time.
 *
 * Rules:
 *   - undefined/null → limit is disabled, no check
 *   - 0 → valid: maxCallsPerTrace=0 blocks all dispatches; maxCostPerTraceUsd=0
 *         blocks any call with a positive estimated cost; maxDurationMs=0 blocks
 *         any retry after the first attempt has returned
 *   - negative → invalid configuration, throws InvalidTraceGuardConfigError
 *
 * Called once per run() when policy.traceGuards is present, not per attempt.
 */
export function validateTraceGuards(guards: TraceGuards): void {
  if (guards.maxCallsPerTrace != null && guards.maxCallsPerTrace < 0) {
    throw new InvalidTraceGuardConfigError("maxCallsPerTrace must be >= 0");
  }
  if (guards.maxCostPerTraceUsd != null && guards.maxCostPerTraceUsd < 0) {
    throw new InvalidTraceGuardConfigError("maxCostPerTraceUsd must be >= 0");
  }
  if (guards.maxDurationMs != null && guards.maxDurationMs < 0) {
    throw new InvalidTraceGuardConfigError("maxDurationMs must be >= 0");
  }
}

/**
 * Increment call count and accumulated cost, then check all three limits.
 *
 * Mutates `state` before checking — counters reflect the current attempt
 * even on violation, so callers have accurate state for telemetry.
 *
 * Duration is checked using wall-clock time from state.startedAt.
 */
export function checkTraceGuard(
  state: TraceGuardState,
  limits: TraceGuards,
  estimatedCostUsdForThisCall: number,
): TraceGuardCheckResult {
  state.callCount += 1;
  state.totalEstimatedCostUsd += estimatedCostUsdForThisCall;

  if (limits.maxCallsPerTrace != null && state.callCount > limits.maxCallsPerTrace) {
    return {
      allowed: false,
      reason: `call limit of ${limits.maxCallsPerTrace} exceeded (attempt ${state.callCount})`,
      dimension: "calls",
    };
  }

  if (
    limits.maxCostPerTraceUsd != null &&
    state.totalEstimatedCostUsd > limits.maxCostPerTraceUsd
  ) {
    return {
      allowed: false,
      reason: `cost limit of $${limits.maxCostPerTraceUsd} exceeded (estimated $${state.totalEstimatedCostUsd.toFixed(6)})`,
      dimension: "cost",
    };
  }

  const elapsedMs = Date.now() - state.startedAt;
  if (limits.maxDurationMs != null && elapsedMs > limits.maxDurationMs) {
    return {
      allowed: false,
      reason: `duration limit of ${limits.maxDurationMs}ms exceeded (elapsed ${elapsedMs}ms)`,
      dimension: "duration",
    };
  }

  return { allowed: true };
}
