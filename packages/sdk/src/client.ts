import type { Message, PolicySnapshot, ProviderTarget, RuntimeEvent } from "./shared";

import { BudgetManager } from "./guardrails/budget";
import { CircuitBreakerRegistry } from "./guardrails/circuit-breaker";
import { WorkflowGuardStore } from "./guardrails/workflow-guard";
import { LoopGuardStore } from "./guardrails/loop-guard";
import { PolicyStore } from "./policy/store";
import { HttpPolicyFetcher, NullPolicyFetcher } from "./policy/fetcher";
import { buildBootstrapSnapshot, buildSafeDefaultSnapshot } from "./policy/defaults";
import { ProviderRegistry } from "./providers/registry";
import { ProviderRouter } from "./routing/router";
import { TelemetryFlusher } from "./telemetry/flusher";
import { HttpTelemetryTransport, NoopTelemetryTransport } from "./telemetry/transport";
import {
  LoretError,
  AllProvidersFailedError,
  BudgetExceededError,
  PiiBlockedError,
  PolicyUnavailableError,
  TraceGuardExceededError,
  WorkflowGuardExceededError,
  LoopGuardExceededError,
} from "./errors";
import { newTraceGuardState, validateTraceGuards } from "./guardrails/trace-guard";
import { checkPrivacy } from "./interceptor/pii";
import type { LoretOptions, RunOptions, RunResult, LoopRecovery } from "./types";
import type { InternalWiring } from "./internal/wiring";

const DEFAULT_CONTROL_PLANE_URL = "https://api.loret.dev";
const DEFAULT_POLICY_TTL_MS = 30_000;

let _welcomeShown = false;

// Nominal fallback rates — per 1,000 tokens.
// Used only when no active ProviderTarget in the current policy has pricing configured.
// Approximate: ~$5/M input, ~$15/M output. NOT billing-grade, NOT model-specific.
// Sole purpose: conservative pre-dispatch budget and guard enforcement.
// Matches MockProvider.estimateCost() for test consistency.
const NOMINAL_INPUT_USD_PER_1K = 0.005;
const NOMINAL_OUTPUT_USD_PER_1K = 0.015;

// Immutable data assembled before execution begins — no service references.
interface ExecutionPlan {
  readonly requestId: string;
  readonly traceId: string;
  readonly startedAt: number;
  readonly policy: PolicySnapshot;
  readonly options: RunOptions;
}

/** Heuristic pre-dispatch cost estimate — not billing-grade. */
interface CostEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /**
   * True when no ProviderTarget had pricing set — estimate used nominal fallback rates.
   */
  readonly usingFallbackPricing: boolean;
}

export class Loret {
  private readonly policyStore: PolicyStore;
  private readonly budgetManager: BudgetManager;
  private readonly workflowGuardStore: WorkflowGuardStore;
  private readonly loopGuardStore: LoopGuardStore;
  private readonly router: ProviderRouter;
  private readonly flusher: TelemetryFlusher;
  private readonly options: Required<
    Pick<LoretOptions, "projectId" | "controlPlaneUrl" | "policyTtlMs">
  >;
  private _usingFallbackPricing: boolean | undefined = undefined; // set after first run()
  private _fallbackPricingWarned = false;   // warn once per instance
  private _missingTraceIdWarned = false;    // warn once per instance
  private _missingLoopSignalWarned = false; // warn once per instance
  private readonly _isTestClient: boolean;  // suppresses production-only warnings

  constructor(options: LoretOptions);
  // @internal — used only by createTestClient() in src/testing.ts
  constructor(options: LoretOptions, wiring: InternalWiring);

  constructor(options: LoretOptions, wiring?: InternalWiring) {
    validateConstructorOptions(options, wiring);

    this.options = {
      projectId: options.projectId,
      controlPlaneUrl: options.controlPlaneUrl ?? DEFAULT_CONTROL_PLANE_URL,
      policyTtlMs: options.policyTtlMs ?? DEFAULT_POLICY_TTL_MS,
    };

    const localMode = isLocalBootstrapMode(options, wiring);
    const bootstrapSnapshot = resolveBootstrapSnapshot(options, wiring);
    const fetcher = buildFetcher(options, wiring, bootstrapSnapshot, this.options.controlPlaneUrl, localMode);
    const transport = buildTransport(options, wiring, this.options.controlPlaneUrl, localMode);
    const registry = new ProviderRegistry(options.adapters);

    this.policyStore = new PolicyStore(bootstrapSnapshot, {
      ttlMs: this.options.policyTtlMs,
      fetcher,
      onRefreshError: options.onPolicyRefreshError,
    });
    this.budgetManager = new BudgetManager();
    this.workflowGuardStore = new WorkflowGuardStore(
      undefined, // evictionTtlMs — use default
      options.stateBackend,
    );
    this.loopGuardStore = new LoopGuardStore();
    this.router = new ProviderRouter({ registry, breakers: new CircuitBreakerRegistry() });
    this.flusher = new TelemetryFlusher({
      projectId: options.projectId,
      transport,
      flushIntervalMs: options.telemetryFlushIntervalMs,
      bufferSize: options.telemetryBufferSize,
      onDrop: options.onTelemetryDrop,
    });
    this.flusher.start();
    this._isTestClient = !!wiring;

    // Guard on !wiring so this does not fire in test clients.
    if (!wiring) warnIfWindowBudgets(bootstrapSnapshot.budgetLimits);
    if (!wiring) warnIfMonitorModeWithGuards(bootstrapSnapshot);

    if (!wiring && !_welcomeShown) {
      _welcomeShown = true;
      console.log(
        "[Loret] Thanks for using Loret! Feedback & issues → https://github.com/loret-sdk/sdk/issues",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async run(options: RunOptions): Promise<RunResult> {
    const plan = this.buildExecutionPlan(options);
    return this.executePlan(plan);
  }

  async shutdown(): Promise<void> {
    await this.flusher.shutdown();
    await this.workflowGuardStore.shutdown();
    this.loopGuardStore.shutdown();
  }

  getDebugState() {
    return {
      policy: {
        version: this.policyStore.getVersion(),
        ageMs: this.policyStore.getAgeMs(),
        isRefreshing: this.policyStore.isRefreshing(),
      },
      telemetry: this.flusher.getStats(),
      budget: this.budgetManager.getCounters(),
      // True when no ProviderTarget had pricing set — cost estimates use nominal fallback.
      // Set after the first run() call; undefined before any call has been made.
      usingFallbackPricing: this._usingFallbackPricing,
    };
  }

  // -------------------------------------------------------------------------
  // Private — execution pipeline
  // -------------------------------------------------------------------------

  private buildExecutionPlan(options: RunOptions): ExecutionPlan {
    if (!options.messages.length) {
      throw new LoretError("messages must not be empty", "UNKNOWN");
    }

    const policy = this.policyStore.getSnapshot();

    if (policy.providerTargets.length === 0) {
      throw new PolicyUnavailableError();
    }

    return {
      requestId: generateId(),
      traceId: typeof options.metadata?.traceId === "string" ? options.metadata.traceId : generateId(),
      startedAt: Date.now(),
      policy,
      options,
    };
  }

  private async executePlan(plan: ExecutionPlan): Promise<RunResult> {
    const { requestId, traceId, startedAt, policy, options } = plan;

    const estimate = buildCostEstimate(options.messages, options.maxTokens, policy.providerTargets);
    this._usingFallbackPricing = estimate.usingFallbackPricing;
    if (estimate.usingFallbackPricing && !this._fallbackPricingWarned && !this._isTestClient) {
      const hasCostGuards =
        policy.budgetLimits.some((b) => b.maxCostUsd != null) ||
        policy.traceGuards?.maxCostPerTraceUsd != null ||
        policy.workflowGuards?.maxCostPerWorkflowUsd != null;
      if (hasCostGuards) {
        this._fallbackPricingWarned = true;
        console.warn(
          "[Loret] Cost estimation is using nominal fallback pricing ($0.005/1k input, $0.015/1k output). " +
            "No active provider target has inputUsdPer1kTokens or outputUsdPer1kTokens configured. " +
            "Budget and cost guard limits may be inaccurate. " +
            "Set inputUsdPer1kTokens and outputUsdPer1kTokens on your provider targets.",
        );
      }
    }
    const budgetAllowed = this.enforceBudget(requestId, traceId, startedAt, policy, estimate, options.metadata);

    // Workflow guard — enforces limits across multiple run() calls sharing the same traceId.
    // Placed before request_started so blocked workflows never emit a started event.
    // Reservations are permanent: counters are not rolled back on later failure.
    const workflowTraceId = typeof options.metadata?.traceId === "string" ? options.metadata.traceId : null;
    if ((policy.workflowGuards || policy.loopGuards) && !workflowTraceId && !this._isTestClient && !this._missingTraceIdWarned) {
      this._missingTraceIdWarned = true;
      console.warn(
        "[Loret] Guards are configured (workflowGuards or loopGuards) but run() was called without " +
          "metadata.traceId. Guards cannot track state across calls without a traceId — limits will not be " +
          "enforced. Pass metadata: { traceId: 'your-workflow-id' } to every run() call in a workflow.",
      );
    }
    if (policy.workflowGuards && workflowTraceId) {
      const wfResult = await this.workflowGuardStore.check(workflowTraceId, policy.workflowGuards, estimate.estimatedCostUsd);
      if (!wfResult.allowed) {
        this.flusher.emit(
          event(requestId, traceId, policy.projectId, "workflow_guard_blocked", {
            errorCode: "WORKFLOW_GUARD_EXCEEDED",
            guardDimension: wfResult.dimension,
            metadata: options.metadata,
          }),
        );
        if (policy.mode === "enforce") {
          if (budgetAllowed) this.budgetManager.rollbackReservation(estimate);
          this.flusher.emit(
            event(requestId, traceId, policy.projectId, "request_failed", {
              errorCode: "WORKFLOW_GUARD_EXCEEDED",
              latencyMs: Date.now() - startedAt,
              metadata: options.metadata,
            }),
          );
          throw new WorkflowGuardExceededError(wfResult.dimension, wfResult.reason);
        }
        // monitor mode: telemetry emitted above, request proceeds
      }
    }

    // Loop guard — synchronous, no I/O. Runs before request_started so
    // blocked loops don't emit a started event.
    if (policy.loopGuards && workflowTraceId && !options.loopSignal && !this._isTestClient && !this._missingLoopSignalWarned) {
      this._missingLoopSignalWarned = true;
      console.warn(
        "[Loret] loopGuards are configured but run() was called without loopSignal. " +
          "Loop detection requires per-turn tool call metadata — pass loopSignal: { toolName, toolArgs, toolResult, resultStatus } " +
          "on every run() call inside an agentic loop.",
      );
    }
    if (policy.loopGuards && workflowTraceId && options.loopSignal) {
      const loopResult = this.loopGuardStore.check(workflowTraceId, options.loopSignal, policy.loopGuards);
      if (!loopResult.allowed) {
        this.flusher.emit(
          event(requestId, traceId, policy.projectId, "loop_guard_blocked", {
            errorCode: "LOOP_GUARD_EXCEEDED",
            guardDimension: loopResult.dimension,
            metadata: options.metadata,
          }),
        );
        if (policy.mode === "enforce") {
          if (budgetAllowed) this.budgetManager.rollbackReservation(estimate);
          const recovery = buildLoopRecovery(options.loopSignal, loopResult.consecutiveClassA);
          return {
            content: "",
            provider: "",
            model: "",
            usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            requestId,
            traceId,
            usedFallback: false,
            latencyMs: Date.now() - startedAt,
            totalAttempts: 0,
            blocked: true,
            recovery,
          };
        }
        // monitor mode: telemetry emitted above, request proceeds
      }
    }

    this.flusher.emit(event(requestId, traceId, policy.projectId, "request_started", { metadata: options.metadata }));

    if (policy.traceGuards) validateTraceGuards(policy.traceGuards);
    const traceGuard = buildTraceGuard(policy, estimate.estimatedCostUsd);

    let routeResult;
    try {
      // Privacy guard — synchronous, no I/O. Inside the try so all failure
      // paths (block, routing, trace guard) emit exactly one request_failed
      // through the shared catch below.
      const messages = this.applyPrivacyGuard(options.messages, policy, requestId, traceId, options.metadata);
      routeResult = await this.router.route({
        base: { messages, maxTokens: options.maxTokens, timeoutMs: policy.timeoutMs },
        targets: policy.providerTargets,
        maxRetries: policy.maxRetries,
        signal: options.signal,
        traceGuard,
      });
    } catch (err) {
      // Release the window counter reservation made by check(). Only needed
      // when check() allowed the request (i.e. a reservation was made).
      if (budgetAllowed) this.budgetManager.rollbackReservation(estimate);
      if (err instanceof TraceGuardExceededError) {
        this.flusher.emit(
          event(requestId, traceId, policy.projectId, "trace_guard_blocked", {
            errorCode: "TRACE_GUARD_EXCEEDED",
            guardDimension: err.dimension,
            metadata: options.metadata,
          }),
        );
      }
      this.flusher.emit(
        event(requestId, traceId, policy.projectId, "request_failed", {
          errorCode: toErrorCode(err),
          latencyMs: Date.now() - startedAt,
          metadata: options.metadata,
        }),
      );
      throw err;
    }

    const { result, provider, model, usedFallback, totalAttempts } = routeResult;

    if (result.type !== "buffered") {
      throw new Error("Streaming responses are not yet supported. Only buffered responses are handled by run().");
    }

    this.budgetManager.consume(result, budgetAllowed ? estimate : null);

    // In monitor mode, trace guard violations are noted in state but do not block.
    // Emit telemetry now that the request has succeeded.
    if (traceGuard?.state.monitoredViolation) {
      this.flusher.emit(
        event(requestId, traceId, policy.projectId, "trace_guard_blocked", {
          errorCode: "TRACE_GUARD_EXCEEDED",
          guardDimension: traceGuard.state.monitoredViolation.dimension,
          metadata: options.metadata,
        }),
      );
    }

    const latencyMs = Date.now() - startedAt;
    this.emitCompletion(requestId, traceId, policy.projectId, provider, model, usedFallback, result.usage, latencyMs, options.metadata);

    return { content: result.content, provider, model, usage: result.usage, requestId, traceId, usedFallback, latencyMs, totalAttempts };
  }

  /**
   * Pre-dispatch budget check. Returns whether the check passed —
   * caller needs this to know whether to rollback the reservation on failure.
   */
  private enforceBudget(
    requestId: string,
    traceId: string,
    startedAt: number,
    policy: PolicySnapshot,
    estimate: CostEstimate,
    metadata: RunOptions["metadata"],
  ): boolean {
    const result = this.budgetManager.check(estimate, policy.budgetLimits);
    if (!result.allowed) {
      this.flusher.emit(
        event(requestId, traceId, policy.projectId, "budget_blocked", {
          errorCode: "BUDGET_EXCEEDED",
          metadata,
        }),
      );
      if (policy.mode === "enforce") {
        this.flusher.emit(
          event(requestId, traceId, policy.projectId, "request_failed", {
            errorCode: "BUDGET_EXCEEDED",
            latencyMs: Date.now() - startedAt,
            metadata,
          }),
        );
        throw new BudgetExceededError(result.reason!, result.scope!);
      }
    }
    return result.allowed;
  }

  private emitCompletion(
    requestId: string,
    traceId: string,
    projectId: string,
    provider: string,
    model: string,
    usedFallback: boolean,
    usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number },
    latencyMs: number,
    metadata: RunOptions["metadata"],
  ): void {
    this.flusher.emit(
      event(requestId, traceId, projectId, "request_completed", {
        provider,
        model,
        status: usedFallback ? "fallback" : "success",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
        latencyMs,
        metadata,
      }),
    );
    if (usedFallback) {
      this.flusher.emit(event(requestId, traceId, projectId, "fallback_triggered", { provider, model, latencyMs }));
    }
  }

  private applyPrivacyGuard(
    messages: readonly Message[],
    policy: ExecutionPlan["policy"],
    requestId: string,
    traceId: string,
    metadata: RunOptions["metadata"],
  ): readonly Message[] {
    if (!policy.privacy || policy.privacy.mode === "off") return messages;

    const privacyResult = checkPrivacy(messages, policy.privacy);
    if (privacyResult.totalMatches === 0) return messages;

    this.flusher.emit(
      event(requestId, traceId, policy.projectId, "privacy_detected", {
        privacyMatchCount: privacyResult.totalMatches,
        privacyCategories: privacyResult.categories as string[],
        metadata,
      }),
    );

    if (policy.privacy.mode === "block") {
      throw new PiiBlockedError([...privacyResult.categories]);
    }
    if (policy.privacy.mode === "redact") {
      return privacyResult.redactedMessages;
    }
    // monitor: telemetry emitted above, original messages used
    return messages;
  }
}

// ---------------------------------------------------------------------------
// Constructor helpers — validate options and resolve wiring
// ---------------------------------------------------------------------------

function validateConstructorOptions(options: LoretOptions, wiring?: InternalWiring): void {
  if (!options.projectId) throw new Error("Loret: projectId is required");
  if (!options.adapters?.length) {
    throw new Error(
      "Loret: at least one provider adapter is required. " +
        "Pass adapters via new Loret({ adapters: [new OpenAIAdapter(...)] }).",
    );
  }

  assertPositiveInteger("policyTtlMs", options.policyTtlMs);
  assertPositiveInteger("telemetryFlushIntervalMs", options.telemetryFlushIntervalMs);
  assertPositiveInteger("telemetryBufferSize", options.telemetryBufferSize);

  const localMode = isLocalBootstrapMode(options, wiring);
  if (!wiring && !localMode) {
    // HTTP-backed control plane is not yet available in this release.
    // Fail at construction — any apiKey provided would be silently ignored.
    throw new Error(
      "Loret: HTTP-backed control plane integration is not yet available in this release. " +
        "Use local provider configuration instead: " +
        "new Loret({ projectId, adapters, providers: [{ provider, model, priority }] }).",
    );
  }

  // In local mode, verify every configured provider has a registered adapter.
  // A name mismatch would otherwise surface only at runtime as a confusing
  // "No providers were available (empty provider chain)" error.
  if (localMode && options.providers?.length) {
    const adapterNames = new Set(options.adapters.map((a) => a.name));
    const missing = options.providers.filter((p) => !adapterNames.has(p.provider));
    if (missing.length > 0) {
      throw new Error(
        `Loret: no adapter registered for provider(s): ${missing.map((p) => `"${p.provider}"`).join(", ")}. ` +
          `Ensure each adapter.name matches the provider field exactly.`,
      );
    }
  }
}

function isLocalBootstrapMode(options: LoretOptions, wiring?: InternalWiring): boolean {
  return !wiring && (options.providers?.length ?? 0) > 0 && !options.apiKey;
}

// daily/monthly limits are per-process — warn once so this isn't a silent surprise.
function warnIfWindowBudgets(limits: PolicySnapshot["budgetLimits"]): void {
  if (limits.some((l) => l.scope === "daily" || l.scope === "monthly")) {
    console.warn(
      "[Loret] Budget limits with scope \"daily\" or \"monthly\" are enforced per process instance. " +
        "They are not globally coordinated across multiple service instances. " +
        "For globally accurate enforcement, use a shared counter store.",
    );
  }
}

// Guards configured but mode="monitor" is easy to miss — warn once at construction.
function warnIfMonitorModeWithGuards(policy: PolicySnapshot): void {
  if (policy.mode !== "monitor") return;

  const hasEnforcementGuards =
    policy.budgetLimits.length > 0 ||
    (policy.traceGuards != null && Object.values(policy.traceGuards).some((v) => v != null)) ||
    (policy.workflowGuards != null && Object.values(policy.workflowGuards).some((v) => v != null)) ||
    (policy.loopGuards != null && Object.values(policy.loopGuards).some((v) => v != null));

  if (hasEnforcementGuards) {
    console.warn(
      '[Loret] Guards are configured but mode is "monitor". ' +
        "Violations will be observed but NOT blocked. " +
        'Set mode: "enforce" to enable blocking behavior.',
    );
  }
}

function resolveBootstrapSnapshot(
  options: LoretOptions,
  wiring?: InternalWiring,
): PolicySnapshot {
  if (wiring?.snapshot) return wiring.snapshot;
  if ((options.providers?.length ?? 0) > 0) {
    return buildBootstrapSnapshot({
      projectId: options.projectId,
      providers: options.providers!,
      mode: options.mode,
      maxRetries: options.maxRetries,
      budgetLimits: options.budgetLimits,
      traceGuards: options.traceGuards,
      workflowGuards: options.workflowGuards,
      loopGuards: options.loopGuards,
      privacy: options.privacy,
    });
  }
  return buildSafeDefaultSnapshot(options.projectId);
}

function buildFetcher(
  options: LoretOptions,
  wiring: InternalWiring | undefined,
  bootstrapSnapshot: PolicySnapshot,
  controlPlaneUrl: string,
  localMode: boolean,
) {
  if (wiring?.snapshot) return new NullPolicyFetcher(wiring.snapshot);
  if (localMode) return new NullPolicyFetcher(bootstrapSnapshot);
  return new HttpPolicyFetcher({ controlPlaneUrl, projectId: options.projectId, apiKey: options.apiKey! });
}

function buildTransport(
  options: LoretOptions,
  wiring: InternalWiring | undefined,
  controlPlaneUrl: string,
  localMode: boolean,
) {
  if (wiring) return wiring.transport ?? new NoopTelemetryTransport();
  if (localMode) return new NoopTelemetryTransport();
  return new HttpTelemetryTransport({ controlPlaneUrl, apiKey: options.apiKey! });
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ~4 chars/token heuristic. Rough but fast enough for pre-dispatch guard enforcement.
function estimateInputTokens(messages: readonly Message[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4);
}

function buildCostEstimate(
  messages: readonly Message[],
  maxTokens: number | undefined,
  providerTargets: readonly ProviderTarget[],
): CostEstimate {
  const inputTokens = estimateInputTokens(messages);
  const outputTokens = maxTokens ?? 0;

  const active = providerTargets.filter((t) => t.isActive);

  // Pool per dimension so a target with only one side configured doesn't
  // mix configured and nominal rates in Math.max().
  const inputConfigured = active.filter((t) => t.inputUsdPer1kTokens !== undefined);
  const outputConfigured = active.filter((t) => t.outputUsdPer1kTokens !== undefined);

  // Worst-case (max) rate per pool; fall back to nominal if pool is empty.
  const inputFallback = inputConfigured.length === 0;
  const outputFallback = outputConfigured.length === 0;

  const inputRate = inputFallback
    ? NOMINAL_INPUT_USD_PER_1K
    : Math.max(...inputConfigured.map((t) => t.inputUsdPer1kTokens!));
  const outputRate = outputFallback
    ? NOMINAL_OUTPUT_USD_PER_1K
    : Math.max(...outputConfigured.map((t) => t.outputUsdPer1kTokens!));

  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate,
    // True if EITHER dimension used nominal fallback rates — estimate may be inaccurate.
    usingFallbackPricing: inputFallback || outputFallback,
  };
}

function buildTraceGuard(policy: PolicySnapshot, estimatedCostUsdPerCall: number) {
  if (!policy.traceGuards) return undefined;
  return { limits: policy.traceGuards, state: newTraceGuardState(), estimatedCostUsdPerCall, mode: policy.mode };
}

function toErrorCode(err: unknown): string {
  if (err instanceof PiiBlockedError) return "PII_BLOCKED";
  if (err instanceof AllProvidersFailedError) return "ALL_PROVIDERS_FAILED";
  if (err instanceof TraceGuardExceededError) return "TRACE_GUARD_EXCEEDED";
  return "UNKNOWN";
}

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Loret: ${name} must be a positive integer, got ${value}`);
  }
}

function buildLoopRecovery(signal: import("./guardrails/loop-guard").LoopSignal, consecutiveCount: number): LoopRecovery {
  const hasArgs = signal.toolArgs != null && signal.toolArgs.length > 0;
  let suggestion: LoopRecovery["suggestion"];
  if (signal.resultStatus === "error") {
    suggestion = "try_different_tool";
  } else if (hasArgs) {
    suggestion = "modify_args";
  } else {
    suggestion = "escalate_to_user";
  }
  return { staleTool: signal.toolName, staleArgs: signal.toolArgs, consecutiveCount, suggestion };
}

function event(
  requestId: string,
  traceId: string,
  projectId: string,
  eventType: RuntimeEvent["eventType"],
  fields: Partial<
    Omit<RuntimeEvent, "requestId" | "traceId" | "projectId" | "eventType" | "occurredAt">
  >,
): RuntimeEvent {
  return { requestId, traceId, projectId, eventType, occurredAt: Date.now(), ...fields };
}
