// ---------------------------------------------------------------------------
// StateBackend — pluggable counter store for workflow guard call counting.
//
// LocalStateBackend (default): in-process Map, zero dependencies.
// RedisStateBackend:           cross-instance via any Redis-compatible client.
//
// Only the call-count dimension uses the backend. Cost and duration limits
// are tracked locally because they require per-call context (token estimates,
// start timestamps) that doesn't coordinate cleanly across instances without
// substantially higher complexity.
// ---------------------------------------------------------------------------

export interface StateBackend {
  /**
   * Atomically increment a counter and return the new value.
   * Creates the counter at 1 if it does not exist.
   * ttlMs is a hint: backends may use it to auto-expire idle keys.
   */
  increment(key: string, ttlMs: number): Promise<number>;

  /** Current value of a counter — 0 if not present or expired. */
  get(key: string): Promise<number>;

  /** Remove a counter immediately. */
  evict(key: string): Promise<void>;

  /** Called during SDK shutdown. Lifecycle of external connections is caller-managed. */
  shutdown(): Promise<void>;
}

/**
 * Default in-process backend. No external dependencies.
 * Eviction is delegated to WorkflowGuardStore.evictStale(); ttlMs is ignored here.
 */
export class LocalStateBackend implements StateBackend {
  private readonly counters = new Map<string, number>();

  async increment(key: string, _ttlMs: number): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async get(key: string): Promise<number> {
    return this.counters.get(key) ?? 0;
  }

  async evict(key: string): Promise<void> {
    this.counters.delete(key);
  }

  async shutdown(): Promise<void> {
    this.counters.clear();
  }
}
