# @loret/sdk

Runtime policy layer for LLM applications. Loret enforces cost budgets, privacy controls, agentic loop detection, retry/fallback routing, and runtime guardrails on every model call — in-process, with no proxy or external service.

Without a control layer, agents burn money in loops, retries mask provider failures, sensitive data leaks into prompts, and cost limits only exist on paper. Loret makes every `run()` call pass through policy enforcement before a single token is spent.

## Stability

`@loret/sdk@1.0.2` is production-ready. Validated against OpenAI (`gpt-4o-mini`, `gpt-4o`) and Anthropic (`claude-haiku-4-5`, `claude-sonnet-4-6`) across 50 probe scenarios and 157 unit tests.

## What Loret is NOT

- Not a proxy — runs fully in-process, no added network hop
- Not a hosted service — no data leaves your application
- Not an LLM wrapper — your provider SDK handles the actual API call
- Not opinionated about your stack — works with any Node.js application

## Installation

```sh
npm install @loret/sdk
```

## Quick start

The simplest configuration: a single provider with a per-call budget cap. For multi-turn agents with fallback routing, workflow limits, and loop detection, see the [agent example](#agent-example) below.

```ts
import { Loret } from "@loret/sdk";
import { OpenAIAdapter } from "@loret/sdk/providers/openai";

const client = new Loret({
  projectId: "my-project",
  adapters: [new OpenAIAdapter(process.env.OPENAI_API_KEY!)],
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  mode: "enforce",
  budgetLimits: [{ scope: "per_call", maxCostUsd: 0.05 }],
});

const result = await client.run({
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
});

console.log(result.content);
await client.shutdown();
```

## Agent example

Copy, paste, run. This simulates an agent stuck in a loop — Loret detects it and returns a structured recovery plan. Costs < $0.01.

```ts
import { Loret } from "@loret/sdk";
import { OpenAIAdapter } from "@loret/sdk/providers/openai";
import type { LoopSignal } from "@loret/sdk";

const client = new Loret({
  projectId: "demo",
  adapters: [new OpenAIAdapter(process.env.OPENAI_API_KEY!)],
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1, inputUsdPer1kTokens: 0.00015, outputUsdPer1kTokens: 0.0006 }],
  mode: "enforce",
  workflowGuards: { maxCallsPerWorkflow: 10, maxCostPerWorkflowUsd: 0.50 },
  loopGuards: { classAConsecutive: 3 },
});

const stuckSignal: LoopSignal = {
  toolName: "search_db", toolArgs: '{"q":"users"}',
  toolResult: "[]", resultStatus: "empty",
};

for (let turn = 1; turn <= 6; turn++) {
  const r = await client.run({
    messages: [{ role: "user", content: "Find user records." }],
    maxTokens: 50, metadata: { traceId: "demo-1" }, loopSignal: stuckSignal,
  });
  if (r.blocked) {
    console.log(`Turn ${turn}: BLOCKED — suggestion: ${r.recovery!.suggestion}`);
    console.log("Recovery context:", JSON.stringify(r.recovery, null, 2));
    break;
  }
  console.log(`Turn ${turn}: allowed ($${r.usage.estimatedCostUsd.toFixed(4)})`);
}
await client.shutdown();
```

Run with `OPENAI_API_KEY` set. Turns 1–3 go through, turn 4 returns a blocked result with a recovery plan instead of throwing. Your agent can use `r.recovery.suggestion` to decide what to do next — try a different tool, modify arguments, or escalate to the user.

## Supported providers

| Import path | Adapter |
|---|---|
| `@loret/sdk/providers/openai` | `OpenAIAdapter` |
| `@loret/sdk/providers/anthropic` | `AnthropicAdapter` |

## Guardrails

### Budget enforcement

```ts
budgetLimits: [
  { scope: "per_call", maxCostUsd: 0.05 },
  { scope: "per_call", maxInputTokens: 4000 },
]
```

Throws `BudgetExceededError` when the policy `mode` is `"enforce"`. Emits a `budget_blocked` telemetry event in both modes.

> **Note:** `daily` and `monthly` budget scopes are enforced per process instance. They are not coordinated across multiple service instances.

### Privacy / PII controls

Loret scans outbound message content for PII patterns before dispatch. Privacy enforcement is configured via `privacy.mode` in your `PolicySnapshot` and operates independently of the top-level `mode` setting:

| Privacy mode | Behavior |
|---|---|
| `"off"` (default) | No scanning |
| `"monitor"` | Detect PII and emit `privacy_detected` telemetry, but send original content |
| `"redact"` | Replace detected PII with `[REDACTED]` placeholders before dispatch |
| `"block"` | Throw `PiiBlockedError` if any PII is detected — request never reaches the provider |

When using bootstrap snapshots, configure privacy via `privacy.mode`:

```ts
const snapshot = buildBootstrapSnapshot({
  projectId: "my-project",
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  privacy: { mode: "redact" },
});
```

Detected entity types: `email`, `phone`, `ssn`, `credit_card`, `secret`, `ipv4`.

> PII detection is pattern-based (regex), not semantic. It catches structured PII reliably but will not detect unstructured sensitive information like names or addresses embedded in prose.

### Trace guards

Limit cost, call count, or wall-clock duration per `run()` call:

```ts
traceGuards: {
  maxCallsPerTrace: 3,
  maxCostPerTraceUsd: 0.10,
  maxDurationMs: 10_000,
}
```

Throws `TraceGuardExceededError` when any limit is reached.

### Retry and fallback

Configure multiple providers with different priorities. The router retries on transient failures and falls back to lower-priority providers automatically. Fallback behavior is explicit — every provider switch emits a `fallback_triggered` telemetry event.

```ts
providers: [
  { provider: "openai",    model: "gpt-4o",      priority: 1 },
  { provider: "anthropic", model: "claude-haiku", priority: 2 },
]
```

### Workflow guards

Limit call count, cost, or wall-clock duration across multiple `run()` calls that share the same `metadata.traceId`. Without workflow guards, a multi-step agent has no aggregate cost ceiling — individual call budgets do not prevent a long-running workflow from accumulating unbounded spend.

```ts
workflowGuards: {
  maxCallsPerWorkflow: 10,
  maxCostPerWorkflowUsd: 0.50,
  maxDurationMs: 60_000,
}
```

Every `run()` call in the workflow must carry the same `metadata.traceId`. Without it, the guard cannot accumulate state and limits are not enforced — the SDK emits a `console.warn` once per instance when this is detected.

Throws `WorkflowGuardExceededError` in enforce mode.

> **Note:** Cost and duration limits are per process instance. Use `RedisStateBackend` via the `stateBackend` option for cross-instance call-count enforcement.

### Loop detection

Content-aware agentic loop detection based on tool call fingerprinting. Detects two stagnation patterns:

- **Class A — exact stagnation**: the same `toolName`, same arguments, and same result appear on consecutive turns. Blocks the workflow after `classAConsecutive` consecutive identical turns (default: 3).
- **Class B — unsuccessful exploration**: same `toolName`, varying arguments, repeated `empty`/`error` results. Suspicion accumulates but **Class B never blocks alone** — it is an informational signal only.

```ts
loopGuards: {
  classAConsecutive: 3,  // block after 3 consecutive identical tool calls
  windowSize: 5,         // sliding window of recent turns (default: 5)
}
```

Each `run()` call in the loop passes a `loopSignal` describing the previous turn's tool call:

```ts
await client.run({
  messages: [...],
  metadata: { traceId: "workflow-id" },
  loopSignal: {
    toolName:     "search_web",
    toolArgs:     JSON.stringify({ query: "..." }),   // raw string — SDK fingerprints internally
    toolResult:   JSON.stringify([]),                 // raw string
    resultStatus: "empty",                           // "success" | "empty" | "error"
  },
});
```

Throws `LoopGuardExceededError` in enforce mode. The error carries `consecutiveClassA`, `suspicion`, and a `hint` field for structured logging.

**Requirements:**
- `metadata.traceId` must be present. Without it, the guard is skipped.
- `loopSignal` is opt-in per call. Calls without it do not update loop state.
- The SDK fingerprints `toolArgs` and `toolResult` internally using FNV1a32. Do not pre-hash.

**Known limitation — rotating tool loops:** If an agent cycles through multiple different tool names each turn (e.g. `tool_a` -> `tool_b` -> `tool_c` -> repeat), with all calls failing, neither Class A nor Class B fires. The `workflowGuards.maxCallsPerWorkflow` limit is the backstop for this case.

> See the [agent example](#agent-example) for a complete multi-turn loop with error handling.

### Cost estimation and pricing

The SDK computes a **pre-dispatch cost estimate** before each `run()` call. This estimate is used to enforce budget limits and trace/workflow cost guards. It is approximate — not billing-grade.

Pricing is configured per provider target in units of **USD per 1,000 tokens**:

```ts
providers: [
  {
    provider: "openai",
    model: "gpt-4o-mini",
    priority: 1,
    inputUsdPer1kTokens: 0.00015,   // $0.15 / 1M input tokens
    outputUsdPer1kTokens: 0.0006,   // $0.60 / 1M output tokens
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    priority: 2,
    inputUsdPer1kTokens: 0.0008,
    outputUsdPer1kTokens: 0.004,
  },
]
```

**Estimation strategy**: the SDK uses the **maximum rate** across all active targets that have pricing configured. This is conservative — it avoids underestimating cost when routing falls back to a more expensive provider.

**Fallback**: when no active target has pricing configured, the SDK falls back to nominal rates ($0.005/1k input, $0.015/1k output). A `console.warn` is emitted once per instance when this occurs. The state is also observable via `client.getDebugState().usingFallbackPricing`.

> Cost guards (`maxCostPerTraceUsd`, `maxCostPerWorkflowUsd`, `maxCostUsd`) depend on the accuracy of these estimates. Configure pricing on your provider targets for meaningful enforcement.

## Mode semantics

The `mode` field controls how budget, trace, workflow, and loop guardrails respond to violations:

| Mode | Behavior |
|---|---|
| `"monitor"` (default) | Violations emit telemetry but the request proceeds |
| `"enforce"` | Violations throw a typed error and block the request |

**Privacy is a separate axis.** The top-level `mode` does not affect privacy enforcement. Privacy is controlled independently by `privacy.mode` (`"off"` / `"monitor"` / `"redact"` / `"block"`).

Example: `mode: "monitor"` with `privacy.mode: "block"` means budget and guard violations are observed only, but requests containing PII are still hard-blocked.

## Error types

| Class | Code | When thrown |
|---|---|---|
| `BudgetExceededError` | `BUDGET_EXCEEDED` | Budget limit reached (enforce mode) |
| `PiiBlockedError` | `PII_BLOCKED` | PII detected (privacy block mode) |
| `AllProvidersFailedError` | `ALL_PROVIDERS_FAILED` | All providers exhausted after retries and fallback |
| `TraceGuardExceededError` | `TRACE_GUARD_EXCEEDED` | Trace guard limit reached (enforce mode) |
| `WorkflowGuardExceededError` | `WORKFLOW_GUARD_EXCEEDED` | Workflow guard limit reached (enforce mode) |
| `LoopGuardExceededError` | `LOOP_GUARD_EXCEEDED` | Loop detected via Class A fingerprint (enforce mode). Carries `consecutiveClassA` and `suspicion` |
| `InvalidTraceGuardConfigError` | `INVALID_TRACE_GUARD_CONFIG` | Negative trace guard limit configured |
| `PolicyUnavailableError` | `POLICY_UNAVAILABLE` | No providers configured |
| `ProviderTimeoutError` | `PROVIDER_TIMEOUT` | Provider exceeded timeout |

All errors extend `LoretError` and expose a `code` field for structured handling.

## Configuration reference

| Option | Type | Required | Description |
|---|---|---|---|
| `projectId` | `string` | ✓ | Identifier for this application instance |
| `adapters` | `ProviderAdapter[]` | ✓ | One adapter per provider (e.g. `OpenAIAdapter`) |
| `providers` | `ProviderTarget[]` | ✓ | Models to use and their priority order |
| `mode` | `"monitor" \| "enforce"` | | Guard behavior. Default: `"monitor"` |
| `budgetLimits` | `BudgetLimit[]` | | Per-call or time-based cost/token limits |
| `traceGuards` | `TraceGuards` | | Per-`run()` call limits |
| `workflowGuards` | `WorkflowGuards` | | Cross-call limits sharing a `traceId` |
| `loopGuards` | `LoopGuards` | | Agentic loop detection config |
| `maxRetries` | `number` | | Retry attempts per provider. Default: `2` |
| `stateBackend` | `StateBackend` | | Workflow state store. Default: in-memory |

> `metadata.traceId` is required on every `run()` call when using `workflowGuards` or `loopGuards`. Without it the guard cannot accumulate state and limits are not enforced — a `console.warn` is emitted once.

## Deployment guarantees

Not all guardrails coordinate across service instances. This table shows what is enforced in each deployment topology:

| Guardrail | Single instance | Multi-instance behavior |
|---|---|---|
| Budget (per_call) | enforced | enforced (stateless, evaluated per call) |
| Budget (daily/monthly) | enforced | per-process only |
| Trace guards | enforced | enforced (stateless, evaluated per run) |
| Workflow call count | enforced | coordinated via `RedisStateBackend` |
| Workflow cost | enforced | per-process only |
| Workflow duration | enforced | per-process only |
| Loop detection | enforced | per-process only |

**Per-process only** means each instance tracks its own state independently. If you run 3 instances with `maxCallsPerWorkflow: 10`, each instance allows 10 calls — not 10 total.

To enable cross-instance call counting, pass a `RedisStateBackend`:

```ts
import { RedisStateBackend } from "@loret/sdk";
import Redis from "ioredis";

const client = new Loret({
  // ...
  stateBackend: new RedisStateBackend(new Redis()),
});
```

Cross-instance cost, duration, and loop detection state are not yet supported. Use `maxCallsPerWorkflow` as the distributed backstop.

## Telemetry

Events are buffered in-process and flushed **asynchronously** — non-blocking, fire-and-forget. Telemetry never adds latency to request execution. Emitted event types:

| Event | When emitted |
|---|---|
| `request_started` | Before provider dispatch |
| `request_completed` | On successful response |
| `request_failed` | On any error that terminates the request |
| `fallback_triggered` | When a fallback provider is used |
| `budget_blocked` | Budget limit exceeded (both modes) |
| `trace_guard_blocked` | Trace guard limit exceeded (both modes). Includes `guardDimension`: `"calls"` \| `"cost"` \| `"duration"` |
| `workflow_guard_blocked` | Workflow guard limit exceeded (both modes). Includes `guardDimension` |
| `loop_guard_blocked` | Class A loop detected (both modes). Includes `guardDimension: "class_a"` |
| `privacy_detected` | PII found in outbound content (all privacy modes except `"off"`) |

Call `client.shutdown()` before process exit to flush buffered events.

### Example: observing a blocked loop

When a loop guard fires, the SDK emits a `loop_guard_blocked` event before throwing:

```ts
// Telemetry event emitted on loop block:
{
  type: "loop_guard_blocked",
  projectId: "research-agent",
  traceId: "research-workflow-1",
  provider: "openai",
  model: "gpt-4o-mini",
  guardDimension: "class_a",
  timestamp: "2026-04-16T14:32:01.000Z"
}
```

In monitor mode (`mode: "monitor"`), the event is still emitted but the request proceeds. This lets you observe loop patterns in production before enabling enforcement.

## Testing

```ts
import { createTestClient, buildBootstrapSnapshot, MockProvider } from "@loret/sdk/testing";

const mock = new MockProvider({ name: "openai", response: "Hello from mock" });
const client = createTestClient({
  adapters: [mock],
  snapshot: buildBootstrapSnapshot({
    projectId: "test",
    providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  }),
});

const result = await client.run({ messages: [{ role: "user", content: "Hi" }] });
```

## Roadmap

**Just shipped in v1.0.2:** Structured loop recovery.

When Loret blocks a loop, `run()` now returns a recovery plan (`staleTool`, `staleArgs`, `suggestion`) instead of only throwing. That gives the agent a structured way to try a different approach.

**What should we build next?** [Vote or suggest features](https://github.com/loret-sdk/sdk/discussions)

- **Response caching** — skip duplicate prompt+model calls to save cost in retry-heavy workflows
- **Streaming support** — `client.stream()` with guard enforcement during streaming
- **Semantic loop detection** — catch paraphrased loops, not just exact repeats

**Building something with Loret?** [Open a discussion](https://github.com/loret-sdk/sdk/discussions) — feedback, rough edges, and feature requests directly shape what gets built next.

## Release scope — v1.0.2

This release supports **local provider configuration only**. HTTP-backed control plane integration (remote policy fetch, telemetry ingest) is not yet available.

## License

MIT
