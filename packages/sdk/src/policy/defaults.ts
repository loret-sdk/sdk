import type { PolicySnapshot, PolicyMode, ProviderTarget, BudgetLimit, TraceGuards, WorkflowGuards, LoopGuards, PrivacyConfig } from "../shared";

// ---------------------------------------------------------------------------
// Bootstrap policy helpers.
// Ensures the SDK is usable immediately without waiting for a control-plane fetch.
// ---------------------------------------------------------------------------

/** Config provided at construction time to seed the initial policy snapshot. */
export interface BootstrapConfig {
  projectId: string;
  providers: Array<{
    provider: string;
    model: string;
    priority?: number;
    /** Pre-dispatch cost estimation rate — per 1,000 input tokens. */
    inputUsdPer1kTokens?: number;
    /** Pre-dispatch cost estimation rate — per 1,000 output tokens. */
    outputUsdPer1kTokens?: number;
  }>;
  mode?: PolicyMode;
  budgetLimits?: BudgetLimit[];
  traceGuards?: TraceGuards;
  workflowGuards?: WorkflowGuards;
  loopGuards?: LoopGuards;
  privacy?: PrivacyConfig;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Build a PolicySnapshot from a BootstrapConfig.
 * version=0 and fetchedAt=0 mark it as stale so the first getSnapshot()
 * triggers an immediate background fetch.
 */
export function buildBootstrapSnapshot(config: BootstrapConfig): PolicySnapshot {
  const targets: ProviderTarget[] = config.providers.map((p, i) => ({
    id: `bootstrap-${i}`,
    provider: p.provider,
    model: p.model,
    priority: p.priority ?? i,
    isActive: true,
    inputUsdPer1kTokens: p.inputUsdPer1kTokens,
    outputUsdPer1kTokens: p.outputUsdPer1kTokens,
  }));

  return {
    projectId: config.projectId,
    version: 0,
    mode: config.mode ?? "monitor", // safe default: observe but don't hard-block
    maxRetries: config.maxRetries ?? 1,
    timeoutMs: config.timeoutMs ?? 30_000,
    providerTargets: targets,
    budgetLimits: config.budgetLimits ?? [],
    traceGuards: config.traceGuards,
    workflowGuards: config.workflowGuards,
    loopGuards: config.loopGuards,
    privacy: config.privacy,
    fetchedAt: 0, // age = ∞ → immediately stale → triggers fetch
  };
}

/**
 * Hard fallback when no bootstrap config is provided.
 * Empty targets causes run() to throw PolicyUnavailableError rather than
 * silently passing with no guardrails.
 */
export function buildSafeDefaultSnapshot(projectId: string): PolicySnapshot {
  return {
    projectId,
    version: 0,
    mode: "monitor",
    maxRetries: 0,
    timeoutMs: 30_000,
    providerTargets: [],
    budgetLimits: [],
    fetchedAt: 0,
  };
}
