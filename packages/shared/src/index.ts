// ---------------------------------------------------------------------------
// @loret/shared — public contract surface
//
// Consumed by:
//   @loret/sdk   — implements against these contracts
//   @loret/api   — validates, stores, and serves these shapes
//   @loret/dashboard — renders these types
//
// Rule: no runtime logic here. Types and interfaces only.
// ---------------------------------------------------------------------------

export type {
  PolicySnapshot,
  PolicyMode,
  ProviderTarget,
  BudgetLimit,
  BudgetScope,
  TraceGuards,
  WorkflowGuards,
  PrivacyMode,
  PiiEntityType,
  PrivacyConfig,
} from "./types/policy";

export type {
  Message,
  TokenUsage,
  ProviderCallInput,
  ProviderCallResult,
  BufferedCallResult,
  StreamingCallResult,
} from "./types/provider";

export type { RuntimeEvent, RuntimeEventType, RuntimeStatus, TelemetryBatch } from "./types/events";

export type { ErrorCode, FailedAttempt, ApiErrorBody } from "./types/errors";
