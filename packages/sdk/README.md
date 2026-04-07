# @loret/sdk

AI runtime guardrail SDK. Sits between your application and LLM providers to enforce budget limits, retry/fallback routing, privacy controls, loop detection, and telemetry — all in-process, with no proxy.

## Stability

`@loret/sdk@1.0.0` is production-ready. Validated against OpenAI (`gpt-4o-mini`, `gpt-4o`) and Anthropic (`claude-haiku-4-5`, `claude-sonnet-4-6`) across 50 probe scenarios and 157 unit tests.

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

```ts
import { Loret } from "@loret/sdk";
import { OpenAIAdapter } from "@loret/sdk/providers/openai";

const client = new Loret({
  projectId: "my-project",
  adapters: [new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! })],
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  budgetLimits: [{ scope: "per_call", maxCostUsd: 0.05 }],
});

const result = await client.run({
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
});

console.log(result.content);
await client.shutdown();
```

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

```ts
providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
// privacy config lives in the policy snapshot
```

Configure `privacy.mode` in your `PolicySnapshot`:
- `"monitor"` — detect and emit telemetry, send original content
- `"redact"` — replace PII with placeholders before dispatch
- `"block"` — throw `PiiBlockedError` if PII is detected

Detected entity types: `email`, `phone`, `ssn`, `credit_card`, `secret`, `ipv4`.

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

Configure multiple providers with different priorities. The router retries on transient failures and falls back to lower-priority providers automatically.

```ts
providers: [
  { provider: "openai",    model: "gpt-4o",      priority: 1 },
  { provider: "anthropic", model: "claude-haiku", priority: 2 },
]
```

### Workflow guards

Limit call count, cost, or wall-clock duration across multiple `run()` calls that share the same `metadata.traceId`:

```ts
workflowGuards: {
  maxCallsPerWorkflow: 10,
  maxCostPerWorkflowUsd: 0.50,
  maxDurationMs: 60_000,
}
```

Every `run()` call in the workflow must carry the same `metadata.traceId`. Without it, the guard cannot accumulate state and limits are not enforced — the SDK emits a `console.warn` once per instance when this is detected.

Throws `WorkflowGuardExceededError` in enforce mode.

> **Note:** Cost and duration limits are per process instance. They are not coordinated across multiple service instances. Use `RedisStateBackend` via the `stateBackend` option for cross-instance call-count enforcement.

### Loop detection

Content-aware agentic loop detection based on tool call fingerprinting. Detects two stagnation patterns:

- **Class A — exact stagnation**: the same `toolName`, same arguments, and same result appear on consecutive turns. Blocks the workflow after `classAConsecutive` consecutive identical turns (default: 3).
- **Class B — unsuccessful exploration**: same `toolName`, varying arguments, repeated `empty`/`error` results. Suspicion accumulates but **Class B never blocks alone** — it is an informational signal only.

```ts
const client = new Loret({
  projectId: "my-agent",
  adapters: [...],
  providers: [...],
  mode: "enforce",
  loopGuards: {
    classAConsecutive: 3,  // block after 3 consecutive identical tool calls
    windowSize: 5,         // sliding window of recent turns (default: 5)
  },
});

// In each agentic turn, pass the tool call metadata from the previous turn:
await client.run({
  messages: [...history...],
  metadata: { traceId: "workflow-id" },
  loopSignal: {
    toolName:     "search_web",
    toolArgs:     JSON.stringify({ query: "..." }),   // raw string — SDK fingerprints internally
    toolResult:   JSON.stringify([]),                 // raw string
    resultStatus: "empty",                           // "success" | "empty" | "error"
  },
});
```

Throws `LoopGuardExceededError` in enforce mode. The error carries `consecutiveClassA`, `suspicion`, and a `hint` field for structured logging and developer guidance.

**Full agentic loop pattern:**

```ts
import { Loret, OpenAIAdapter, LoopGuardExceededError } from "@loret/sdk";
import type { LoopSignal } from "@loret/sdk";

const client = new Loret({
  projectId: "my-agent",
  adapters: [new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! })],
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  mode: "enforce",
  loopGuards: { classAConsecutive: 3 },
});

const messages = [{ role: "user" as const, content: "Research solid-state battery breakthroughs." }];
let prevSignal: LoopSignal | undefined;

for (let turn = 0; turn < 10; turn++) {
  try {
    const result = await client.run({
      messages,
      metadata: { traceId: "research-workflow-1" },
      loopSignal: prevSignal,  // pass last turn's tool call metadata
    });

    // Parse the tool call from the LLM response, execute it, then build the next signal
    const toolCall = parseToolCall(result.content);  // your extraction logic
    if (!toolCall) break;                             // LLM finished

    const toolResult = await executeTool(toolCall);

    prevSignal = {
      toolName:     toolCall.name,
      toolArgs:     JSON.stringify(toolCall.args),
      toolResult:   JSON.stringify(toolResult),
      resultStatus: toolResult.length === 0 ? "empty" : "success",
    };

    messages.push(
      { role: "assistant", content: result.content },
      { role: "user",      content: `Tool result: ${JSON.stringify(toolResult)}. Continue.` },
    );
  } catch (err) {
    if (err instanceof LoopGuardExceededError) {
      console.error(`Loop detected at turn ${turn}:`, err.message);
      console.info("Hint:", err.hint);
      break;
    }
    throw err;
  }
}
```

**Requirements:**
- `metadata.traceId` must be present on every `run()` call in the loop. Without it, the guard is skipped.
- `loopSignal` is opt-in per call. Calls without `loopSignal` do not update loop state.
- The SDK fingerprints `toolArgs` and `toolResult` internally using FNV1a32. Do not pre-hash.

**Known limitation — rotating tool loops:** If an agent cycles through multiple different tool names each turn (e.g. `tool_a` → `tool_b` → `tool_c` → repeat), with all calls failing, Class A never fires (different tool name) and Class B never fires (different tool name). This pattern is not caught by loop detection. The `workflowGuards.maxCallsPerWorkflow` limit is the backstop for this case — set it to a value low enough to bound the total number of turns regardless of tool diversity.

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

The `mode` field controls how budget, trace, and workflow guardrails respond to violations:

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
| `AllProvidersFailedError` | `ALL_PROVIDERS_FAILED` | All providers exhausted |
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

## Telemetry

Events are buffered in-process and flushed **asynchronously** — non-blocking, fire-and-forget. Telemetry emission never adds latency to request execution. Emitted event types:

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

## Release scope — v1.0.0

This release supports **local provider configuration only**. HTTP-backed control plane integration (remote policy fetch, telemetry ingest) is not yet available.

## License

MIT
