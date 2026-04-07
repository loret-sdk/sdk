// ---------------------------------------------------------------------------
// @loret/sdk/testing — test utilities entry point
//
// Import from here in test files only. This module is excluded from the
// production bundle by bundlers that respect package.json "exports".
// ---------------------------------------------------------------------------

export { MockProvider } from "./providers/mock";
export type { MockProviderOptions } from "./providers/mock";

export { NoopTelemetryTransport, ConsoleTelemetryTransport } from "./telemetry/transport";
export { NullPolicyFetcher } from "./policy/fetcher";
export { buildBootstrapSnapshot } from "./policy/defaults";

// ---------------------------------------------------------------------------
// createTestClient — wire a fully isolated Loret instance for tests.
// No HTTP calls to the control plane or telemetry endpoint.
// ---------------------------------------------------------------------------

import type { PolicySnapshot } from "./shared";

import { Loret } from "./client";
import { NoopTelemetryTransport } from "./telemetry/transport";
import type { TelemetryTransport } from "./telemetry/transport";
import type { ProviderAdapter } from "./providers/adapter";

export type { InternalWiring } from "./internal/wiring";

export interface TestClientOptions {
  /** Adapters to register. Must include every provider referenced in snapshot. */
  adapters: ProviderAdapter[];

  /**
   * The policy snapshot to use. Build one with buildBootstrapSnapshot() or
   * construct the PolicySnapshot object directly for full control.
   * fetchedAt is always overwritten to Date.now() to prevent background refresh.
   */
  snapshot: PolicySnapshot;

  /**
   * Telemetry transport. Defaults to NoopTelemetryTransport, which captures
   * sent batches in-memory (accessible via transport.sent) for assertion.
   */
  transport?: TelemetryTransport;

  /** Overrides snapshot.projectId if provided. */
  projectId?: string;

  /** Max events the telemetry buffer can hold before dropping. Default: 1000. */
  telemetryBufferSize?: number;

  /** Called when an event is dropped due to buffer overflow. */
  onTelemetryDrop?: (count: number) => void;
}

/**
 * Create a Loret client wired for local testing.
 *
 * Guarantees:
 *   - No HTTP calls to the control plane (NullPolicyFetcher)
 *   - No HTTP calls for telemetry (NoopTelemetryTransport by default)
 *   - Budget limits and policy mode active immediately on first run()
 *   - fetchedAt is always set to Date.now() — no background refresh race
 */
export function createTestClient(options: TestClientOptions): Loret {
  const transport = options.transport ?? new NoopTelemetryTransport();

  // Stamp fetchedAt as fresh so PolicyStore never schedules a background refresh.
  const snapshot: PolicySnapshot = {
    ...options.snapshot,
    projectId: options.projectId ?? options.snapshot.projectId,
    fetchedAt: Date.now(),
  };

  return new Loret(
    {
      projectId: snapshot.projectId,
      apiKey: "test", // required by constructor validation; never sent
      adapters: options.adapters,
      telemetryBufferSize: options.telemetryBufferSize,
      onTelemetryDrop: options.onTelemetryDrop,
    },
    { snapshot, transport }, // InternalWiring — bypasses all HTTP setup
  );
}
