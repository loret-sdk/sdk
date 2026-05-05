# @loret/sdk

> The runtime reliability layer for AI agents.

- Stops repeated tool-call loops
- Prevents silent task failure
- Runs in-process, no proxy

**A stuck agent doesn't just waste money — it fails the task. Loret catches the loop so the agent can recover or escalate.**

### Quick Start

**LangChain** — one call, Loret handles the rest:

```bash
npm install @loret/langchain @loret/sdk
```

```ts
import { guard } from "@loret/langchain";

const agent = guard(createReactAgent, { llm, tools: [deployService, checkHealth] });
await agent.invoke({ messages });
```

**Vercel AI SDK** — one call, Loret wraps the model:

```bash
npm install @loret/vercel @loret/sdk ai
```

```ts
import { guard } from "@loret/vercel";

const model = await guard(openai("gpt-4.1"));
const result = await generateText({ model, tools, prompt });
```

**No framework** — wrap any async function:

```bash
npm install @loret/sdk
```

```ts
import { loret } from "@loret/sdk";

const session = loret();
const safeCheck = session.guard(checkHealth);

const result = await safeCheck("payments-api");
session.reset();
```

---

## Features

- **Loop Detection & Recovery** — Detects repeating tool calls and breaks the loop so the agent can recover or escalate
- **Hard Budget Limits** — Per call, per trace, and per workflow
- **Retry & Fallback** — Automatic fallback across providers
- **Framework Integrations** — Drop-in support for [LangChain](https://www.npmjs.com/package/@loret/langchain) and [Vercel AI SDK](https://www.npmjs.com/package/@loret/vercel)
- **PII Protection** — Detects, redacts, or blocks sensitive data
- **In-Process** — No proxy, no extra network hop, near-zero latency

---

## How It Works

Loret wraps your agent's tools (LangChain) or model (Vercel AI SDK) and watches every tool call.

1. Agent calls a tool normally
2. Loret fingerprints the call — tool name, arguments, result
3. If the fingerprint matches a loop pattern, Loret replaces the result with a recovery message
4. The agent reads it, changes approach, and continues

No crash, no manual intervention. The agent self-corrects.

---

## How Loop Detection Works

**Class A — Exact Stagnation**
Same tool + same inputs + same result across consecutive turns → blocked deterministically

**Class B — Unsuccessful Exploration**
Same tool + different inputs + repeated failures → blocked after threshold (4 failures with 2+ distinct args, or 4 failures with identical error). Per-tool sliding window; a success clears the window.

No embeddings, no LLM calls, no semantic guesswork. Deterministic and fast.

---

## Supported providers

| Import path | Adapter |
|---|---|
| `@loret/sdk/providers/openai` | `OpenAIAdapter` |
| `@loret/sdk/providers/anthropic` | `AnthropicAdapter` |
| `@loret/sdk/providers/custom` | `CustomAdapter` |

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

See [How Loop Detection Works](#how-loop-detection-works) for the detection model. Configuration:

```ts
loopGuards: {
  classAConsecutive: 3,    // block after 3 consecutive identical tool calls
  classBSuspicion: 4,      // block after 4 failures in per-tool window
  classBToolWindow: 6,     // per-tool sliding window size (default: 6)
  classBDistinctArgs: 2,   // min distinct args for Class B path (a)
  windowSize: 12,          // global sliding window (default: 12)
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

## Error Handling

The `guard()` and `loret()` APIs handle loop recovery automatically — loops are resolved, not thrown. If the agent ignores recovery and keeps looping, Loret terminates the run with an error.

For the low-level `Loret` client, all errors extend `LoretError` with a `code` field:

| Class | Code | When thrown |
|---|---|---|
| `BudgetExceededError` | `BUDGET_EXCEEDED` | Budget limit reached (enforce mode) |
| `PiiBlockedError` | `PII_BLOCKED` | PII detected (privacy block mode) |
| `AllProvidersFailedError` | `ALL_PROVIDERS_FAILED` | All providers exhausted after retries and fallback |
| `TraceGuardExceededError` | `TRACE_GUARD_EXCEEDED` | Trace guard limit reached (enforce mode) |
| `WorkflowGuardExceededError` | `WORKFLOW_GUARD_EXCEEDED` | Workflow guard limit reached (enforce mode) |
| `LoopGuardExceededError` | `LOOP_GUARD_EXCEEDED` | Loop detected via Class A or Class B (enforce mode). Carries `consecutiveClassA` and `suspicion` |
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

## Telemetry & Observability

Loret logs detection events and a run summary to the console — enabled by default.

```
🔄 [Loret] Loop detected: check_deploy_status() (3 consecutive calls with same args)

✅ [Loret] Run completed
   • Tool calls: 7 executed, 2 blocked
   • Loops caught: 1
   • Actions taken: 1 recovery
   • Estimated savings: ~5 calls
   • Final status: Recovery successful
```

Only meaningful events are printed — no per-tool-call noise. Disable with `verbose: false` in options.

### Structured telemetry

The `Loret` client also emits structured events asynchronously for integration with external observability tools. Events are buffered in-process and flushed **asynchronously** — non-blocking, fire-and-forget. Telemetry never adds latency to request execution. Emitted event types:

| Event | When emitted |
|---|---|
| `request_started` | Before provider dispatch |
| `request_completed` | On successful response |
| `request_failed` | On any error that terminates the request |
| `fallback_triggered` | When a fallback provider is used |
| `budget_blocked` | Budget limit exceeded (both modes) |
| `trace_guard_blocked` | Trace guard limit exceeded (both modes). Includes `guardDimension`: `"calls"` \| `"cost"` \| `"duration"` |
| `workflow_guard_blocked` | Workflow guard limit exceeded (both modes). Includes `guardDimension` |
| `loop_guard_blocked` | Loop detected via Class A or Class B (both modes). Includes `guardDimension: "class_a"` or `"class_b"` |
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

## Guarantees & Limitations

- Cost is estimated pre-dispatch (not billing-accurate)
- PII detection is pattern-based (not semantic)
- Budget limits are per process unless backed by external state

These are deliberate tradeoffs that keep the runtime fast, predictable, and reliable.

## Roadmap

- **Pluggable observability** — pipe events to Datadog, Grafana, or your own logger
- **Response caching** — skip duplicate prompt+model calls to save cost in retry-heavy workflows
- **Streaming support** — `client.stream()` with guard enforcement during streaming

[Vote or suggest features](https://github.com/loret-sdk/sdk/discussions)

## License

MIT
