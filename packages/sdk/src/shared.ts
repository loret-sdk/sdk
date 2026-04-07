// ---------------------------------------------------------------------------
// Inlined shared type contracts.
// Types are inlined so consumers don't need @loret/shared installed.
//
// IMPORTANT: Keep structurally identical to packages/shared/.
// Canonical source: packages/shared/src/types/
// Drift guard:      src/__tests__/type-contracts.check.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider call contracts (from types/provider.ts)
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

export interface ProviderCallInput {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Message[];
  readonly maxTokens?: number;
  readonly timeoutMs: number;
  /** Composed AbortSignal (caller signal + timeout). Respect this to cancel in-flight work. */
  readonly signal?: AbortSignal;
}

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

// ---------------------------------------------------------------------------
// Policy contracts (from types/policy.ts)
// ---------------------------------------------------------------------------

export type PolicyMode = "monitor" | "enforce";

export type BudgetScope = "per_call" | "daily" | "monthly";

export type PrivacyMode = "off" | "monitor" | "redact" | "block";

/**
 * PII entity categories supported in this release.
 * Detection is pattern-based only — not guaranteed to be exhaustive.
 */
export type PiiEntityType = "email" | "phone" | "ssn" | "credit_card" | "secret" | "ipv4";

export interface PrivacyConfig {
  readonly mode: PrivacyMode;
  /**
   * Entity types to scan for. Defaults to all supported types when omitted.
   * Narrow this list to reduce false positives in known-safe content domains.
   */
  readonly entities?: readonly PiiEntityType[];
}

export interface TraceGuards {
  /** Maximum provider dispatch attempts (retries + fallbacks) per run() call. */
  readonly maxCallsPerTrace?: number;
  /** Maximum accumulated estimated cost (USD) across all attempts in a run() call. */
  readonly maxCostPerTraceUsd?: number;
  /** Maximum wall-clock duration (ms) for an entire run() call. */
  readonly maxDurationMs?: number;
}

/**
 * Workflow-level guardrails — enforced across multiple run() calls
 * sharing the same metadata.traceId.
 * State is in-process only — not coordinated across service instances.
 */
export interface WorkflowGuards {
  /** Maximum run() calls allowed within this workflow. */
  readonly maxCallsPerWorkflow?: number;
  /** Maximum cumulative estimated cost (USD) across all run() calls in this workflow. */
  readonly maxCostPerWorkflowUsd?: number;
  /** Maximum wall-clock duration (ms) from the first run() call in this workflow. */
  readonly maxDurationMs?: number;
}

/**
 * Content-aware agentic loop detection — structural fingerprint guards.
 *
 * Detects two stagnation patterns from per-run() tool call metadata:
 *
 *   Class A (exact stagnation): same toolName + same args fingerprint +
 *     same result fingerprint on N consecutive turns. Blocks the workflow.
 *
 *   Class B (unsuccessful exploration): same toolName, varying args,
 *     repeated empty/error results. Suspicion accumulates but does NOT
 *     block alone — it is an informational signal only.
 *
 * Requires `metadata.traceId` and `loopSignal` on each run() call.
 * State is in-process only — not coordinated across service instances.
 */
export interface LoopGuards {
  /**
   * Number of consecutive Class A (exact stagnation) turns required to block.
   * Default: 3. Minimum practical value: 2.
   */
  readonly classAConsecutive?: number;
  /**
   * Size of the sliding window used to track recent turns.
   * Default: 5. Must be ≥ classAConsecutive.
   */
  readonly windowSize?: number;
}

export interface ProviderTarget {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly priority: number;
  readonly isActive: boolean;
  /**
   * Pre-dispatch cost estimation rates — per 1,000 tokens.
   * Used only for budget and guardrail pre-dispatch checks, not billing.
   * When absent on all active targets, the SDK falls back to nominal rates
   * ($0.005/1k input, $0.015/1k output). Values must be ≥ 0.
   */
  readonly inputUsdPer1kTokens?: number;
  readonly outputUsdPer1kTokens?: number;
}

export interface BudgetLimit {
  readonly scope: BudgetScope;
  readonly maxCostUsd?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

/**
 * Immutable snapshot of a project's runtime policy.
 * Fetched from the control plane and cached in-process.
 *
 * ## Mode semantics
 *
 * `mode` controls enforcement for budget and structural guardrails (trace/workflow):
 * - `"enforce"` — violations throw a typed error and block the request.
 * - `"monitor"` — violations emit telemetry (`budget_blocked`, `trace_guard_blocked`,
 *   `workflow_guard_blocked`) but the request proceeds.
 *
 * Privacy is controlled independently via the `privacy.mode` field:
 * - `"off"` / `"monitor"` / `"redact"` / `"block"` (see `PrivacyConfig`).
 * - Privacy mode is not affected by the top-level `mode` field.
 *
 * Example: `mode: "monitor"` + `privacy.mode: "block"` → budget/trace/workflow
 * violations are observed only, but requests with PII are still hard-blocked.
 */
export interface PolicySnapshot {
  readonly projectId: string;
  readonly version: number;
  readonly mode: PolicyMode;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly providerTargets: readonly ProviderTarget[];
  readonly budgetLimits: readonly BudgetLimit[];
  readonly traceGuards?: TraceGuards;
  readonly workflowGuards?: WorkflowGuards;
  readonly loopGuards?: LoopGuards;
  readonly privacy?: PrivacyConfig;
  /** Epoch ms when this snapshot was fetched. Used for TTL checks. */
  readonly fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Telemetry event contracts (from types/events.ts)
// ---------------------------------------------------------------------------

export type RuntimeEventType =
  | "request_started"
  | "request_completed"
  | "request_failed"
  | "fallback_triggered"
  | "budget_blocked"
  | "trace_guard_blocked"
  | "workflow_guard_blocked"
  | "loop_guard_blocked"
  | "safety_blocked"
  | "privacy_detected";

export type RuntimeStatus = "success" | "failed" | "blocked" | "fallback";

export interface RuntimeEvent {
  readonly requestId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly eventType: RuntimeEventType;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: RuntimeStatus;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Populated by trace_guard_blocked and workflow_guard_blocked events. Values: "calls" | "cost" | "duration". */
  readonly guardDimension?: string;
  /** Populated by privacy_detected events. Never contains raw PII values. */
  readonly privacyMatchCount?: number;
  readonly privacyCategories?: readonly string[];
  /** Epoch ms when the event occurred in the agent process. */
  readonly occurredAt: number;
}

export interface TelemetryBatch {
  readonly projectId: string;
  readonly events: readonly RuntimeEvent[];
}

// ---------------------------------------------------------------------------
// Error contracts (from types/errors.ts)
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
