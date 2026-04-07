// Compile-time drift guard: asserts structural equality between sdk/src/shared.ts
// (distribution copy) and packages/shared/ (canonical source).
// Any required field addition, removal, or type change causes a TS2322 here.
// Note: optional field additions are not caught by structural assignability.

// SDK distribution copy
import type {
  PolicySnapshot as SdkPolicySnapshot,
  BudgetLimit as SdkBudgetLimit,
  ProviderTarget as SdkProviderTarget,
  TraceGuards as SdkTraceGuards,
  WorkflowGuards as SdkWorkflowGuards,
  PrivacyConfig as SdkPrivacyConfig,
  RuntimeEvent as SdkRuntimeEvent,
  TelemetryBatch as SdkTelemetryBatch,
  ErrorCode as SdkErrorCode,
  FailedAttempt as SdkFailedAttempt,
  ApiErrorBody as SdkApiErrorBody,
  Message as SdkMessage,
  TokenUsage as SdkTokenUsage,
  ProviderCallInput as SdkProviderCallInput,
  BufferedCallResult as SdkBufferedCallResult,
  StreamingCallResult as SdkStreamingCallResult,
} from "../shared";

// Canonical source
import type {
  PolicySnapshot as SharedPolicySnapshot,
  BudgetLimit as SharedBudgetLimit,
  ProviderTarget as SharedProviderTarget,
  TraceGuards as SharedTraceGuards,
  WorkflowGuards as SharedWorkflowGuards,
  PrivacyConfig as SharedPrivacyConfig,
  RuntimeEvent as SharedRuntimeEvent,
  TelemetryBatch as SharedTelemetryBatch,
  ErrorCode as SharedErrorCode,
  FailedAttempt as SharedFailedAttempt,
  ApiErrorBody as SharedApiErrorBody,
  Message as SharedMessage,
  TokenUsage as SharedTokenUsage,
  ProviderCallInput as SharedProviderCallInput,
  BufferedCallResult as SharedBufferedCallResult,
  StreamingCallResult as SharedStreamingCallResult,
} from "@loret/shared";

// ---------------------------------------------------------------------------
// Equality primitive.
// [A] and [B] wrappers prevent union type distribution.
// Resolves to `true` iff A and B are mutually assignable (structurally equal).
// Resolves to `never` if they diverge — making the const assignment below fail.
// ---------------------------------------------------------------------------

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ---------------------------------------------------------------------------
// One check per shared type. A compile error here means the two copies have
// diverged and sdk/src/shared.ts must be updated to match packages/shared/.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unused-vars */

// Policy types
const _policySnapshot: Equals<SdkPolicySnapshot, SharedPolicySnapshot> = true;
const _budgetLimit: Equals<SdkBudgetLimit, SharedBudgetLimit> = true;
const _providerTarget: Equals<SdkProviderTarget, SharedProviderTarget> = true;
const _traceGuards: Equals<SdkTraceGuards, SharedTraceGuards> = true;
const _workflowGuards: Equals<SdkWorkflowGuards, SharedWorkflowGuards> = true;
const _privacyConfig: Equals<SdkPrivacyConfig, SharedPrivacyConfig> = true;

// Telemetry event types
const _runtimeEvent: Equals<SdkRuntimeEvent, SharedRuntimeEvent> = true;
const _telemetryBatch: Equals<SdkTelemetryBatch, SharedTelemetryBatch> = true;

// Error types
const _errorCode: Equals<SdkErrorCode, SharedErrorCode> = true;
const _failedAttempt: Equals<SdkFailedAttempt, SharedFailedAttempt> = true;
const _apiErrorBody: Equals<SdkApiErrorBody, SharedApiErrorBody> = true;

// Provider call types
const _message: Equals<SdkMessage, SharedMessage> = true;
const _tokenUsage: Equals<SdkTokenUsage, SharedTokenUsage> = true;
const _providerCallInput: Equals<SdkProviderCallInput, SharedProviderCallInput> = true;
const _bufferedCallResult: Equals<SdkBufferedCallResult, SharedBufferedCallResult> = true;
const _streamingCallResult: Equals<SdkStreamingCallResult, SharedStreamingCallResult> = true;

/* eslint-enable @typescript-eslint/no-unused-vars */
