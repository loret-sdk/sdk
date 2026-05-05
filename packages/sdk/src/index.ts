// ---------------------------------------------------------------------------
// @loret/sdk — production entry point
//
// Test utilities (MockProvider, createTestClient) are intentionally absent.
// They live in @loret/sdk/testing to keep production bundles clean.
// ---------------------------------------------------------------------------

export { Loret } from "./client";

export type { LoretOptions, RunOptions, RunResult, LoopRecovery } from "./types";

export type { ProviderAdapter } from "./providers/adapter";
export { ProviderError } from "./providers/adapter";

export { OpenAIAdapter } from "./providers/openai";
export { AnthropicAdapter } from "./providers/anthropic";
export { CustomAdapter } from "./providers/custom";
export type { CustomAdapterOptions, CustomExecuteInput, CustomExecuteResult } from "./providers/custom";

export {
  LoretError,
  AllProvidersFailedError,
  BudgetExceededError,
  PiiBlockedError,
  ProviderTimeoutError,
  PolicyUnavailableError,
  TraceGuardExceededError,
  InvalidTraceGuardConfigError,
  WorkflowGuardExceededError,
  LoopGuardExceededError,
} from "./errors";

export type { StateBackend } from "./guardrails/state-backend";
export { LocalStateBackend } from "./guardrails/state-backend";
export { RedisStateBackend } from "./guardrails/redis-state-backend";
export type { MinimalRedisClient } from "./guardrails/redis-state-backend";

// Re-export shared types consumers commonly need
export type {
  PolicySnapshot,
  ProviderTarget,
  BudgetLimit,
  RuntimeEvent,
  FailedAttempt,
  PrivacyConfig,
  PrivacyMode,
  PiiEntityType,
  TraceGuards,
  WorkflowGuards,
  LoopGuards,
} from "./shared";

export type { LoopSignal } from "./guardrails/loop-guard";
export { LoopGuardStore } from "./guardrails/loop-guard";
export type { LoopGuardCheckResult, LoopGuardViolation } from "./guardrails/loop-guard";

export { loret } from "./session";
export type { LoretSession, LoretSessionOptions } from "./session";
