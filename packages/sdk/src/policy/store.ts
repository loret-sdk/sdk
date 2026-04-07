import type { PolicySnapshot } from "../shared";

import type { PolicyFetcher } from "./fetcher";

// ---------------------------------------------------------------------------
// PolicyStore — synchronous hot path with background TTL refresh.
//
// getSnapshot() never awaits: if stale, a deduplicated background refresh
// fires and the current snapshot is returned immediately. On fetch failure,
// the last-known-good snapshot is retained.
// ---------------------------------------------------------------------------

export interface PolicyStoreOptions {
  ttlMs: number;
  fetcher: PolicyFetcher;
  /** Called when a background refresh fails. Use for logging/alerting. */
  onRefreshError?: (err: unknown) => void;
}

export class PolicyStore {
  // Single mutable reference — replaced atomically on refresh.
  private snapshot: PolicySnapshot;
  private readonly ttlMs: number;
  private readonly fetcher: PolicyFetcher;
  private readonly onRefreshError?: (err: unknown) => void;

  // Deduplication guard: at most one in-flight fetch at any time.
  private refreshInFlight: Promise<void> | null = null;

  constructor(bootstrap: PolicySnapshot, options: PolicyStoreOptions) {
    this.snapshot = bootstrap;
    this.ttlMs = options.ttlMs;
    this.fetcher = options.fetcher;
    this.onRefreshError = options.onRefreshError;
  }

  // -------------------------------------------------------------------------
  // Hot path — MUST remain synchronous
  // -------------------------------------------------------------------------

  /** Returns the current snapshot, scheduling a background refresh if stale. Never throws. */
  getSnapshot(): PolicySnapshot {
    if (this.isStale()) {
      this.scheduleRefresh();
    }
    return this.snapshot;
  }

  // -------------------------------------------------------------------------
  // Background refresh — off the hot path
  // -------------------------------------------------------------------------

  /**
   * Force an immediate refresh, waiting for completion.
   * Use on startup or when a policy-invalidation signal is received.
   */
  async forceRefresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    await this.doRefresh();
  }

  private scheduleRefresh(): void {
    // Already in flight — deduplicate.
    if (this.refreshInFlight) return;

    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
  }

  private async doRefresh(): Promise<void> {
    try {
      const fresh = await this.fetcher.fetch();
      this.snapshot = fresh;
    } catch (err) {
      // Retain last-known-good snapshot on failure.
      this.onRefreshError?.(err);
    }
  }

  private isStale(): boolean {
    return Date.now() - this.snapshot.fetchedAt > this.ttlMs;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  getVersion(): number {
    return this.snapshot.version;
  }

  getAgeMs(): number {
    return Date.now() - this.snapshot.fetchedAt;
  }

  isRefreshing(): boolean {
    return this.refreshInFlight !== null;
  }
}
