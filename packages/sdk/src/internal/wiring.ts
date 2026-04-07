import type { PolicySnapshot } from "../shared";

import type { TelemetryTransport } from "../telemetry/transport";

// ---------------------------------------------------------------------------
// InternalWiring — package-private dependency injection.
//
// NOT exported from src/index.ts. Only re-exported from src/testing.ts so
// that createTestClient() can construct a fully-wired Loret instance
// without any control-plane calls.
//
// Using a second constructor parameter (rather than underscore-prefixed
// fields on LoretOptions) keeps the public API surface clean.
// ---------------------------------------------------------------------------

export interface InternalWiring {
  /** Policy snapshot to use. fetchedAt is overwritten to Date.now() by createTestClient. */
  snapshot: PolicySnapshot;

  /** Telemetry transport override. Defaults to NoopTelemetryTransport. */
  transport?: TelemetryTransport;
}
