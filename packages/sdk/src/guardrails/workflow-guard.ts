import type { WorkflowGuards } from "../shared";
import { LocalStateBackend, type StateBackend } from "./state-backend";

// ---------------------------------------------------------------------------
// WorkflowGuardStore — enforces limits across run() calls sharing a traceId.
//
// Call counting is delegated to a StateBackend (default: in-memory).
// Swap in RedisStateBackend for cross-instance call limit enforcement.
//
// Cost and duration are per-process only — cross-instance coordination
// would require distributed clock sync.
// Local state is evicted opportunistically on each check() call.
// ---------------------------------------------------------------------------

export const DEFAULT_EVICTION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Local state tracked per workflow — cost and duration only. */
interface LocalWorkflowState {
  totalEstimatedCostUsd: number;
  readonly startedAt: number;
  lastUpdatedAt: number;
}

export type WorkflowGuardDimension = "calls" | "cost" | "duration";

export interface WorkflowGuardViolation {
  readonly allowed: false;
  readonly reason: string;
  readonly dimension: WorkflowGuardDimension;
}

export type WorkflowGuardCheckResult = { readonly allowed: true } | WorkflowGuardViolation;

export class WorkflowGuardStore {
  /** Local state for cost/duration tracking — always in-process. */
  private readonly localStates = new Map<string, LocalWorkflowState>();
  private readonly backend: StateBackend;
  private readonly evictionTtlMs: number;

  /**
   * @param evictionTtlMs  Inactivity TTL for local state eviction (default: 1h).
   * @param backend        Counter backend for call counting (default: LocalStateBackend).
   *                       Pass a RedisStateBackend for cross-instance enforcement.
   */
  constructor(
    evictionTtlMs: number = DEFAULT_EVICTION_TTL_MS,
    backend: StateBackend = new LocalStateBackend(),
  ) {
    this.evictionTtlMs = evictionTtlMs;
    this.backend = backend;
  }

  /**
   * Check limits and reserve the call slot if allowed.
   * Async because call counting may hit a remote backend.
   * Reservations are permanent — not rolled back on later failure.
   * Backend errors fail open to preserve availability.
   */
  async check(
    traceId: string,
    limits: WorkflowGuards,
    estimatedCostUsd: number,
  ): Promise<WorkflowGuardCheckResult> {
    this.evictStale();

    const now = Date.now();
    let local = this.localStates.get(traceId);

    if (!local) {
      local = { totalEstimatedCostUsd: 0, startedAt: now, lastUpdatedAt: now };
      this.localStates.set(traceId, local);
    }

    // Refresh activity timestamp before checks so active workflows are not
    // prematurely evicted while still running.
    local.lastUpdatedAt = now;

    // ── Duration (local) ──────────────────────────────────────────────────
    if (limits.maxDurationMs != null) {
      const elapsedMs = now - local.startedAt;
      if (elapsedMs > limits.maxDurationMs) {
        return {
          allowed: false,
          reason: `workflow duration limit of ${limits.maxDurationMs}ms exceeded (elapsed ${elapsedMs}ms)`,
          dimension: "duration",
        };
      }
    }

    // ── Cost (local — per-instance approximation) ─────────────────────────
    if (limits.maxCostPerWorkflowUsd != null) {
      const nextCost = local.totalEstimatedCostUsd + estimatedCostUsd;
      if (nextCost > limits.maxCostPerWorkflowUsd) {
        return {
          allowed: false,
          reason: `workflow cost limit of $${limits.maxCostPerWorkflowUsd} exceeded (estimated $${nextCost.toFixed(6)})`,
          dimension: "cost",
        };
      }
    }

    // ── Calls (backend — cross-instance when RedisStateBackend is used) ───
    if (limits.maxCallsPerWorkflow != null) {
      let callCount: number;
      try {
        callCount = await this.backend.increment(traceId, this.evictionTtlMs);
      } catch {
        // Backend unavailable — fail open to preserve SDK availability.
        callCount = 0;
      }
      if (callCount > limits.maxCallsPerWorkflow) {
        return {
          allowed: false,
          reason: `workflow call limit of ${limits.maxCallsPerWorkflow} exceeded (attempt ${callCount})`,
          dimension: "calls",
        };
      }
    }

    // All limits satisfied — commit local reservation.
    local.totalEstimatedCostUsd += estimatedCostUsd;

    return { allowed: true };
  }

  /** Explicitly evict a traceId — prefer this over waiting for TTL on known completion. */
  async evictWorkflow(traceId: string): Promise<void> {
    this.localStates.delete(traceId);
    try {
      await this.backend.evict(traceId);
    } catch {
      // Non-fatal — local state already cleared.
    }
  }

  /** Flush backend state and clear local state. Called during SDK shutdown. */
  async shutdown(): Promise<void> {
    this.localStates.clear();
    await this.backend.shutdown();
  }

  /** Cost/duration state for a traceId. Call count is in the backend. Tests/debug only. */
  getState(traceId: string): Readonly<LocalWorkflowState> | undefined {
    return this.localStates.get(traceId);
  }

  /** Number of active local workflow states. Intended for tests and debug. */
  get size(): number {
    return this.localStates.size;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [id, state] of this.localStates) {
      if (now - state.lastUpdatedAt > this.evictionTtlMs) {
        this.localStates.delete(id);
        // Best-effort backend eviction — fire and forget.
        void this.backend.evict(id).catch(() => undefined);
      }
    }
  }
}
