// ---------------------------------------------------------------------------
// Shared error contracts.
//
// Error *classes* live in the SDK (they carry stack traces and instanceof
// semantics). This file defines the data shapes that cross the API boundary
// (e.g., structured error responses) and the FailedAttempt record that
// AllProvidersFailedError carries.
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "BUDGET_EXCEEDED"
  | "ALL_PROVIDERS_FAILED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "SAFETY_BLOCKED"
  | "PII_BLOCKED"
  | "POLICY_UNAVAILABLE"
  | "TRACE_GUARD_EXCEEDED"
  | "INVALID_TRACE_GUARD_CONFIG"
  | "WORKFLOW_GUARD_EXCEEDED"
  | "LOOP_GUARD_EXCEEDED"
  | "UNKNOWN";

/**
 * One recorded attempt within a provider dispatch chain.
 * Collected by the router and surfaced in AllProvidersFailedError.
 */
export interface FailedAttempt {
  readonly provider: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly isRetryable: boolean;
  readonly durationMs: number;
}

/**
 * Structured error shape included in API error responses.
 * Mirrors the SDK error model so dashboards can render failure detail.
 */
export interface ApiErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly attempts?: readonly FailedAttempt[];
}
