// ---------------------------------------------------------------------------
// Telemetry event contracts — emitted by the SDK, ingested by the API.
// ---------------------------------------------------------------------------

export type RuntimeEventType =
  | "request_started"
  | "request_completed"
  | "request_failed"
  | "fallback_triggered"
  | "budget_blocked"
  | "trace_guard_blocked"
  | "workflow_guard_blocked"
  | "loop_guard_blocked"
  | "safety_blocked"
  | "privacy_detected";

export type RuntimeStatus = "success" | "failed" | "blocked" | "fallback";

export interface RuntimeEvent {
  readonly requestId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly eventType: RuntimeEventType;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: RuntimeStatus;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Populated by trace_guard_blocked and workflow_guard_blocked events. Values: "calls" | "cost" | "duration". */
  readonly guardDimension?: string;
  /** Populated by privacy_detected events. Never contains raw PII values. */
  readonly privacyMatchCount?: number;
  readonly privacyCategories?: readonly string[];
  /** Epoch ms when the event occurred in the agent process. */
  readonly occurredAt: number;
}

// ---------------------------------------------------------------------------
// Telemetry ingest payload — batched by the flusher, posted to the API.
// ---------------------------------------------------------------------------

export interface TelemetryBatch {
  readonly projectId: string;
  readonly events: readonly RuntimeEvent[];
}
