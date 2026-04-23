import type { Message, BudgetLimit, PolicyMode, TraceGuards, WorkflowGuards, LoopGuards, PrivacyConfig } from "./shared";
import type { LoopSignal } from "./guardrails/loop-guard";

import type { ProviderAdapter } from "./providers/adapter";
import type { StateBackend } from "./guardrails/state-backend";
export type { Message };
export type { LoopSignal };

export interface RunOptions {
  messages:  readonly Message[];
  maxTokens?: number;
  metadata?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  /**
   * Tool call metadata for the current turn in an agentic loop.
   * Required for content-aware loop detection — args and result are
   * fingerprinted internally, no pre-hashing required.
   * Has no effect unless `loopGuards` is set and `metadata.traceId` is present.
   */
  loopSignal?: LoopSignal;
}

export interface LoopRecovery {
  /** The tool that was repeatedly called. */
  staleTool: string;
  /** The raw arguments string from the repeated call. */
  staleArgs: string | undefined;
  /** How many consecutive identical calls were made. */
  consecutiveCount: number;
  /** Actionable suggestion for the agent's next step. */
  suggestion: "try_different_tool" | "modify_args" | "escalate_to_user";
}

export interface RunResult {
  content: string;
  provider: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  requestId: string;
  traceId: string;
  usedFallback: boolean;
  latencyMs: number;
  totalAttempts: number;
  /** True when a loop guard blocked this call. When true, `content` is empty and `recovery` is set. */
  blocked?: boolean;
  /** Structured recovery context — present only when `blocked` is true. */
  recovery?: LoopRecovery;
}

export interface LoretOptions {
  projectId: string;
  apiKey?: string;
  controlPlaneUrl?: string;

  /** Bootstrap provider targets — used immediately while the first policy fetch runs in the background. */
  providers?: Array<{
    provider: string;
    model: string;
    priority?: number;
    /** Pre-dispatch cost estimation rate — per 1,000 input tokens. Used for budget and guard checks only. */
    inputUsdPer1kTokens?: number;
    /** Pre-dispatch cost estimation rate — per 1,000 output tokens. Used for budget and guard checks only. */
    outputUsdPer1kTokens?: number;
  }>;

  /**
   * Guardrail policy mode for local bootstrap.
   * `"enforce"` blocks requests that violate limits; `"monitor"` logs violations but allows them through.
   * Defaults to `"monitor"`.
   */
  mode?: PolicyMode;

  /** Maximum provider dispatch attempts per run() call (retries + 1). Defaults to 1. */
  maxRetries?: number;

  /**
   * Bootstrap budget limits. Applied until the first successful policy refresh in HTTP-backed mode.
   * `daily`/`monthly` scopes are enforced per process instance only — not coordinated across instances.
   */
  budgetLimits?: BudgetLimit[];

  /** Trace-level guardrails: cap calls, cost, or wall-clock duration per run() call. */
  traceGuards?: TraceGuards;

  /**
   * Workflow-level guardrails: cap calls, cost, or duration across multiple run() calls
   * sharing the same metadata.traceId. Use to bound agent loops and multi-turn workflows.
   * Enforced per process instance only — not globally coordinated across service instances.
   */
  workflowGuards?: WorkflowGuards;

  /**
   * Content-aware loop detection via structural tool call fingerprinting.
   * Detects exact stagnation (Class A) and unsuccessful exploration (Class B).
   * Requires `metadata.traceId` and `loopSignal` on each run() call in the loop.
   * Enforced per process instance only.
   */
  loopGuards?: LoopGuards;

  /** PII detection config. Mode `"off"` (default) disables scanning. */
  privacy?: PrivacyConfig;

  /**
   * Backend for workflow guard call counting.
   * Defaults to LocalStateBackend (in-process — not coordinated across instances).
   * Pass a RedisStateBackend to enforce maxCallsPerWorkflow across all instances
   * sharing the same Redis.
   *
   * Note: maxCostPerWorkflowUsd and maxDurationMs are always per-instance
   * regardless of the backend, as they require local accumulated context.
   */
  stateBackend?: StateBackend;

  adapters: ProviderAdapter[];

  policyTtlMs?: number;
  telemetryFlushIntervalMs?: number;
  telemetryBufferSize?: number;

  onPolicyRefreshError?: (err: unknown) => void;
  onTelemetryDrop?: (count: number) => void;
}
