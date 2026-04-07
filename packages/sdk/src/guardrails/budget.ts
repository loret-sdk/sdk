import type { BudgetLimit, BufferedCallResult } from "../shared";

export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly scope?: string;
}

export interface WindowCounter {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  readonly windowStart: number;
}

export interface BudgetEstimate {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_MONTH = 30 * MS_PER_DAY;

export class BudgetManager {
  // BudgetManager owns only the rolling window counters.
  // Limits come from the current policy snapshot at check() call time,
  // so budget checks always reflect the latest fetched policy.
  private daily: WindowCounter = newCounter();
  private monthly: WindowCounter = newCounter();

  // -------------------------------------------------------------------------
  // Pre-call check — synchronous, hot path
  // -------------------------------------------------------------------------

  /**
   * Does NOT throw — callers decide whether to block based on PolicyMode.
   * `limits` must come from the current policy snapshot, not cached state.
   *
   * When allowed, speculatively reserves the estimated usage in window counters
   * to prevent TOCTOU under concurrent run() calls. The reservation must be
   * released via consume() on success or rollbackReservation() on failure.
   */
  check(estimated: BudgetEstimate, limits: readonly BudgetLimit[]): BudgetCheckResult {
    this.rollExpiredWindows();

    for (const limit of limits) {
      const result = this.checkLimit(limit, estimated);
      if (!result.allowed) return result;
    }

    // Reserve estimated window usage so concurrent run() calls see an
    // up-to-date counter before their provider calls complete.
    const est = normalize(estimated);
    this.daily.inputTokens += est.inputTokens;
    this.daily.outputTokens += est.outputTokens;
    this.daily.costUsd += est.costUsd;
    this.monthly.inputTokens += est.inputTokens;
    this.monthly.outputTokens += est.outputTokens;
    this.monthly.costUsd += est.costUsd;

    return { allowed: true };
  }

  // -------------------------------------------------------------------------
  // Post-call consumption — synchronous, called only on success
  // -------------------------------------------------------------------------

  /**
   * Adjusts window counters from the reserved estimate to actual usage.
   * Pass `null` for `estimated` when no reservation was made (monitor-mode
   * budget violations that were allowed to continue).
   */
  consume(result: BufferedCallResult, estimated: BudgetEstimate | null): void {
    this.rollExpiredWindows();
    const { inputTokens, outputTokens, estimatedCostUsd } = result.usage;

    if (estimated === null) {
      // No reservation — just add actuals.
      this.daily.inputTokens += inputTokens;
      this.daily.outputTokens += outputTokens;
      this.daily.costUsd += estimatedCostUsd;
      this.monthly.inputTokens += inputTokens;
      this.monthly.outputTokens += outputTokens;
      this.monthly.costUsd += estimatedCostUsd;
      return;
    }

    // Replace reservation with actuals. Math.max(0, ...) guards against
    // negative counters when the window rolled between reserve and consume.
    const est = normalize(estimated);
    this.daily.inputTokens = Math.max(0, this.daily.inputTokens - est.inputTokens) + inputTokens;
    this.daily.outputTokens = Math.max(0, this.daily.outputTokens - est.outputTokens) + outputTokens;
    this.daily.costUsd = Math.max(0, this.daily.costUsd - est.costUsd) + estimatedCostUsd;
    this.monthly.inputTokens = Math.max(0, this.monthly.inputTokens - est.inputTokens) + inputTokens;
    this.monthly.outputTokens = Math.max(0, this.monthly.outputTokens - est.outputTokens) + outputTokens;
    this.monthly.costUsd = Math.max(0, this.monthly.costUsd - est.costUsd) + estimatedCostUsd;
  }

  /**
   * Releases the window reservation made by check() when a run() call fails.
   * Must be called on every failure path after a successful check().
   */
  rollbackReservation(estimated: BudgetEstimate): void {
    this.rollExpiredWindows();
    const est = normalize(estimated);

    // Math.max(0, ...) prevents negative counters if the window rolled
    // between the reservation and this rollback.
    this.daily.inputTokens = Math.max(0, this.daily.inputTokens - est.inputTokens);
    this.daily.outputTokens = Math.max(0, this.daily.outputTokens - est.outputTokens);
    this.daily.costUsd = Math.max(0, this.daily.costUsd - est.costUsd);
    this.monthly.inputTokens = Math.max(0, this.monthly.inputTokens - est.inputTokens);
    this.monthly.outputTokens = Math.max(0, this.monthly.outputTokens - est.outputTokens);
    this.monthly.costUsd = Math.max(0, this.monthly.costUsd - est.costUsd);
  }

  getCounters() {
    return {
      daily: { ...this.daily } as Readonly<WindowCounter>,
      monthly: { ...this.monthly } as Readonly<WindowCounter>,
    };
  }

  private checkLimit(limit: BudgetLimit, raw: BudgetEstimate): BudgetCheckResult {
    const est = normalize(raw);
    if (limit.scope === "per_call") return checkPerCallLimit(limit, est);
    return checkWindowLimit(limit, limit.scope === "daily" ? this.daily : this.monthly, est);
  }

  private rollExpiredWindows(): void {
    const now = Date.now();
    if (now - this.daily.windowStart >= MS_PER_DAY) this.daily = newCounter();
    if (now - this.monthly.windowStart >= MS_PER_MONTH) this.monthly = newCounter();
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

interface Normalized {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function normalize(raw: BudgetEstimate): Normalized {
  return {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    costUsd: raw.estimatedCostUsd ?? 0,
  };
}

function checkPerCallLimit(limit: BudgetLimit, est: Normalized): BudgetCheckResult {
  if (limit.maxCostUsd != null && est.costUsd > limit.maxCostUsd) {
    return {
      allowed: false,
      reason: `per_call cost ${est.costUsd} exceeds limit ${limit.maxCostUsd}`,
      scope: "per_call",
    };
  }
  if (limit.maxInputTokens != null && est.inputTokens > limit.maxInputTokens) {
    return {
      allowed: false,
      reason: `per_call input tokens ${est.inputTokens} exceeds limit ${limit.maxInputTokens}`,
      scope: "per_call",
    };
  }
  if (limit.maxOutputTokens != null && est.outputTokens > limit.maxOutputTokens) {
    return {
      allowed: false,
      reason: `per_call output tokens ${est.outputTokens} exceeds limit ${limit.maxOutputTokens}`,
      scope: "per_call",
    };
  }
  return { allowed: true };
}

function checkWindowLimit(
  limit: BudgetLimit,
  counter: WindowCounter,
  est: Normalized,
): BudgetCheckResult {
  if (limit.maxCostUsd != null && counter.costUsd + est.costUsd > limit.maxCostUsd) {
    return { allowed: false, reason: `${limit.scope} cost limit exceeded`, scope: limit.scope };
  }
  if (limit.maxInputTokens != null && counter.inputTokens + est.inputTokens > limit.maxInputTokens) {
    return {
      allowed: false,
      reason: `${limit.scope} input token limit exceeded`,
      scope: limit.scope,
    };
  }
  if (
    limit.maxOutputTokens != null &&
    counter.outputTokens + est.outputTokens > limit.maxOutputTokens
  ) {
    return {
      allowed: false,
      reason: `${limit.scope} output token limit exceeded`,
      scope: limit.scope,
    };
  }
  return { allowed: true };
}

function newCounter(): WindowCounter {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, windowStart: Date.now() };
}
