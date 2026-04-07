// ---------------------------------------------------------------------------
// CircuitBreakerRegistry — per-provider circuit breaker.
//
//   closed ──(failures >= threshold)──► open
//   open   ──(recoveryMs elapsed)────► half-open
//   half-open ──(success >= threshold)──► closed
//   half-open ──(any failure)──────────► open
//
// All methods are synchronous O(1). Safe on the hot path.
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

interface BreakerEntry {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  halfOpenSuccesses: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Ms before attempting recovery (open → half-open). Default: 30_000 */
  recoveryMs?: number;
  /** Successes in half-open before closing. Default: 2 */
  halfOpenSuccessThreshold?: number;
}

export interface CircuitBreakerSnapshot {
  readonly provider: string;
  readonly state: CircuitState;
  readonly failures: number;
  readonly lastFailureAt: number;
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, BreakerEntry>();
  private readonly failureThreshold: number;
  private readonly recoveryMs: number;
  private readonly halfOpenSuccessThreshold: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryMs = options.recoveryMs ?? 30_000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /** Register a provider. Idempotent — safe to call multiple times. */
  register(provider: string): void {
    if (!this.breakers.has(provider)) {
      this.breakers.set(provider, newEntry());
    }
  }

  // -------------------------------------------------------------------------
  // Hot-path reads — synchronous
  // -------------------------------------------------------------------------

  /**
   * Returns true if the circuit is open and the provider should be skipped.
   * Also transitions open → half-open when recovery window has elapsed.
   */
  isOpen(provider: string): boolean {
    const entry = this.breakers.get(provider);
    if (!entry) return false; // unregistered providers are never blocked

    if (entry.state === "closed" || entry.state === "half-open") return false;

    // open — check if recovery window has passed
    const elapsed = Date.now() - entry.lastFailureAt;
    if (elapsed >= this.recoveryMs) {
      entry.state = "half-open";
      entry.halfOpenSuccesses = 0;
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // State transitions — called by ProviderRouter after each dispatch attempt
  // -------------------------------------------------------------------------

  recordSuccess(provider: string): void {
    const entry = this.breakers.get(provider);
    if (!entry) return;

    if (entry.state === "closed") {
      entry.failures = 0;
      return;
    }

    if (entry.state === "half-open") {
      entry.halfOpenSuccesses++;
      if (entry.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        entry.state = "closed";
        entry.failures = 0;
        entry.halfOpenSuccesses = 0;
      }
    }
  }

  recordFailure(provider: string): void {
    const entry = this.breakers.get(provider);
    if (!entry) return;

    entry.failures++;
    entry.lastFailureAt = Date.now();

    if (entry.state === "half-open") {
      // Any failure in half-open immediately reopens the circuit.
      entry.state = "open";
      return;
    }

    if (entry.state === "closed" && entry.failures >= this.failureThreshold) {
      entry.state = "open";
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  getSnapshot(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.entries()).map(([provider, e]) => ({
      provider,
      state: e.state,
      failures: e.failures,
      lastFailureAt: e.lastFailureAt,
    }));
  }

  reset(provider: string): void {
    this.breakers.set(provider, newEntry());
  }

  resetAll(): void {
    for (const key of this.breakers.keys()) {
      this.breakers.set(key, newEntry());
    }
  }
}

function newEntry(): BreakerEntry {
  return { state: "closed", failures: 0, lastFailureAt: 0, halfOpenSuccesses: 0 };
}
