import type { TelemetryBatch } from "../shared";

// TelemetryTransport abstracts the delivery mechanism so the flusher never
// has a direct HTTP dependency (test, dev, and prod transports swap cleanly).

export interface TelemetryTransport {
  /**
   * Send a batch of events to the destination.
   * Implementations must not throw — failures should be handled internally.
   * The flusher relies on this contract to avoid wrapping every call in try/catch.
   */
  send(batch: TelemetryBatch): Promise<void>;
}

// ---------------------------------------------------------------------------
// HttpTelemetryTransport — production implementation
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  controlPlaneUrl: string;
  apiKey: string;
  /** Request timeout for each flush POST. Default: 10_000ms */
  timeoutMs?: number;
}

export class HttpTelemetryTransport implements TelemetryTransport {
  private readonly options: Required<HttpTransportOptions>;

  constructor(options: HttpTransportOptions) {
    this.options = { timeoutMs: 10_000, ...options };
  }

  async send(_batch: TelemetryBatch): Promise<void> {
    // TODO: POST ${this.options.controlPlaneUrl}/v1/events/ingest
    // Authorization: Bearer ${this.options.apiKey}, timeout: this.options.timeoutMs
    // Swallow all errors — transport must never throw.
    throw new Error("Not implemented");
  }
}

// ---------------------------------------------------------------------------
// NoopTelemetryTransport — used in tests and when telemetry is disabled
// ---------------------------------------------------------------------------

export class NoopTelemetryTransport implements TelemetryTransport {
  readonly sent: TelemetryBatch[] = [];

  async send(batch: TelemetryBatch): Promise<void> {
    this.sent.push(batch);
  }
}

// ---------------------------------------------------------------------------
// ConsoleTelemetryTransport — prints structured events to stdout.
// Use during local validation and development to observe the event stream.
// ---------------------------------------------------------------------------

export class ConsoleTelemetryTransport implements TelemetryTransport {
  async send(batch: TelemetryBatch): Promise<void> {
    for (const event of batch.events) {
      const ts = new Date(event.occurredAt).toISOString();
      const tag = `[loret:${event.eventType}]`;
      const details: Record<string, unknown> = { requestId: event.requestId };

      if (event.provider) details.provider = event.provider;
      if (event.model) details.model = event.model;
      if (event.status) details.status = event.status;
      if (event.latencyMs != null) details.latencyMs = event.latencyMs;
      if (event.inputTokens) details.inputTokens = event.inputTokens;
      if (event.outputTokens) details.outputTokens = event.outputTokens;
      if (event.estimatedCostUsd)
        details.estimatedCostUsd = `$${event.estimatedCostUsd.toFixed(6)}`;
      if (event.errorCode) details.errorCode = event.errorCode;

      console.log(`${ts} ${tag}`, JSON.stringify(details));
    }
  }
}
