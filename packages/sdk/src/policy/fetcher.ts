import type { PolicySnapshot } from "../shared";

// ---------------------------------------------------------------------------
// PolicyFetcher — single responsibility: HTTP fetch + response mapping.
// Consumed only by PolicyStore. Never called from the hot path.
// ---------------------------------------------------------------------------

export interface PolicyFetcherOptions {
  controlPlaneUrl: string;
  projectId: string;
  apiKey: string;
  /** Request timeout for the policy fetch itself. Default: 5_000ms */
  fetchTimeoutMs?: number;
}

export interface PolicyFetcher {
  fetch(): Promise<PolicySnapshot>;
}

export class HttpPolicyFetcher implements PolicyFetcher {
  private readonly options: Required<PolicyFetcherOptions>;

  constructor(options: PolicyFetcherOptions) {
    this.options = { fetchTimeoutMs: 5_000, ...options };
  }

  async fetch(): Promise<PolicySnapshot> {
    // TODO: GET ${this.options.controlPlaneUrl}/v1/projects/${this.options.projectId}/policy
    // Authorization: Bearer ${this.options.apiKey}, timeout: this.options.fetchTimeoutMs
    // Validate response, map to PolicySnapshot with fetchedAt = Date.now()
    throw new Error("Not implemented");
  }
}

/**
 * NullPolicyFetcher — used in tests and when running fully offline.
 * Always returns the snapshot it was constructed with.
 */
export class NullPolicyFetcher implements PolicyFetcher {
  constructor(private readonly snapshot: PolicySnapshot) {}

  async fetch(): Promise<PolicySnapshot> {
    return { ...this.snapshot, fetchedAt: Date.now() };
  }
}
