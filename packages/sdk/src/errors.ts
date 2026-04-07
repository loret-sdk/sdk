import type { ErrorCode, FailedAttempt } from "./shared";

// ---------------------------------------------------------------------------
// SDK error classes.
//
// All errors extend LoretError for instanceof checks and structured logging.
// Error *codes* are defined in @loret/shared so the API can reference them.
// ---------------------------------------------------------------------------

export class LoretError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
    this.name = "LoretError";
    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// AllProvidersFailedError — carries full attempt history
// ---------------------------------------------------------------------------

export class AllProvidersFailedError extends LoretError {
  constructor(
    /** Ordered list of every attempt across all providers and retries. */
    public readonly attempts: readonly FailedAttempt[],
  ) {
    const summary =
      attempts.length === 0
        ? "No providers were available (empty provider chain)"
        : attempts.map((a) => `${a.provider}/${a.model} [${a.errorCode}]`).join(", ");

    super(`All provider attempts failed: ${summary}`, "ALL_PROVIDERS_FAILED");
    this.name = "AllProvidersFailedError";
  }

  /** Quick check: were all failures due to open circuit breakers? */
  get wasCircuitBroken(): boolean {
    return this.attempts.every((a) => a.errorCode === "CIRCUIT_OPEN");
  }

  /** Were any attempts retryable? */
  get hadRetryableFailures(): boolean {
    return this.attempts.some((a) => a.isRetryable);
  }
}

// ---------------------------------------------------------------------------
// Budget errors
// ---------------------------------------------------------------------------

export class BudgetExceededError extends LoretError {
  constructor(
    public readonly reason: string,
    public readonly scope: string,
  ) {
    super(`Budget exceeded (${scope}): ${reason}`, "BUDGET_EXCEEDED");
    this.name = "BudgetExceededError";
  }
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

export class ProviderTimeoutError extends LoretError {
  constructor(
    public readonly provider: string,
    public readonly timeoutMs: number,
  ) {
    super(`Provider "${provider}" timed out after ${timeoutMs}ms`, "PROVIDER_TIMEOUT");
    this.name = "ProviderTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Privacy errors
// ---------------------------------------------------------------------------

export class PiiBlockedError extends LoretError {
  constructor(
    /** Detected entity categories. Never contains raw PII values. */
    public readonly detectedCategories: readonly string[],
  ) {
    super(
      `Request blocked: PII detected in outbound content (${detectedCategories.join(", ")})`,
      "PII_BLOCKED",
    );
    this.name = "PiiBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Safety errors
// ---------------------------------------------------------------------------

export class SafetyBlockedError extends LoretError {
  constructor(
    public readonly hookName: string,
    reason?: string,
  ) {
    super(reason ?? `Request blocked by safety hook "${hookName}"`, "SAFETY_BLOCKED");
    this.name = "SafetyBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Trace guard errors
// ---------------------------------------------------------------------------

export class TraceGuardExceededError extends LoretError {
  constructor(
    public readonly dimension: "calls" | "cost" | "duration",
    public readonly reason: string,
  ) {
    super(`Trace guard exceeded (${dimension}): ${reason}`, "TRACE_GUARD_EXCEEDED");
    this.name = "TraceGuardExceededError";
  }
}

export class InvalidTraceGuardConfigError extends LoretError {
  constructor(public readonly field: string) {
    super(`Invalid trace guard configuration: ${field}`, "INVALID_TRACE_GUARD_CONFIG");
    this.name = "InvalidTraceGuardConfigError";
  }
}

// ---------------------------------------------------------------------------
// Workflow guard errors
// ---------------------------------------------------------------------------

export class WorkflowGuardExceededError extends LoretError {
  constructor(
    public readonly dimension: "calls" | "cost" | "duration",
    public readonly reason: string,
  ) {
    super(`Workflow guard exceeded (${dimension}): ${reason}`, "WORKFLOW_GUARD_EXCEEDED");
    this.name = "WorkflowGuardExceededError";
  }
}

// ---------------------------------------------------------------------------
// Loop guard errors
// ---------------------------------------------------------------------------

export class LoopGuardExceededError extends LoretError {
  /** Hint for the developer on how to resolve the loop. */
  readonly hint =
    "The agent repeated the same tool call with identical inputs and results. " +
    "Vary the query, switch tools, or add an exit condition when results are empty.";

  constructor(
    public readonly reason: string,
    public readonly consecutiveClassA: number,
    public readonly suspicion: number,
  ) {
    super(`Loop guard exceeded: ${reason}`, "LOOP_GUARD_EXCEEDED");
    this.name = "LoopGuardExceededError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Policy errors
// ---------------------------------------------------------------------------

export class PolicyUnavailableError extends LoretError {
  constructor() {
    super(
      "No policy snapshot is available and no bootstrap config was provided. " +
        "Pass providers via new Loret({ providers: [...] }) to enable cold-start.",
      "POLICY_UNAVAILABLE",
    );
    this.name = "PolicyUnavailableError";
  }
}
