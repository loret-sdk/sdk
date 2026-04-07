// ---------------------------------------------------------------------------
// Policy contracts — shared between SDK (consumer) and API (producer).
// All fields are readonly: snapshots are immutable once created.
// ---------------------------------------------------------------------------

export type PolicyMode = "monitor" | "enforce";

export type BudgetScope = "per_call" | "daily" | "monthly";

// ---------------------------------------------------------------------------
// Privacy guardrails
// ---------------------------------------------------------------------------

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
 * that share the same metadata.traceId.
 *
 * Use these to bound agent loops and multi-turn workflows.
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
  readonly provider: string; // open string — not a closed union
  readonly model: string;
  readonly priority: number; // lower = higher priority
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
 * Never mutated after construction — the store swaps the reference atomically.
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
