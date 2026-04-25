# Loret

**Stop your agents from quietly burning money.**

When an agent gets stuck in a loop — repeating the same tool call over and over — costs spiral before anyone notices.

Loret is a **lightweight, in-process runtime guardrail SDK** that catches this automatically.

- Zero proxy
- Zero extra latency
- Works with any LLM framework

### Quick Start

```bash
npm install @loret/sdk
```

```ts
import { Loret } from "@loret/sdk";
import { OpenAIAdapter } from "@loret/sdk/providers/openai";

const loret = new Loret({
  projectId: "my-agent",
  adapters: [new OpenAIAdapter(process.env.OPENAI_API_KEY!)],
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  budgetLimits: [{ scope: "per_call", maxCostUsd: 0.05 }],
  loopGuards: { classAConsecutive: 3 },
  mode: "enforce",
});

const result = await loret.run({
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 256,
});

console.log(result.content);
await loret.shutdown();
```

---

## Table of Contents

- [Features](#features)
- [Why Loret](#why-loret)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Examples](#examples)
- [Telemetry & Observability](#telemetry--observability)
- [Error Handling](#error-handling)
- [Roadmap](#roadmap)
- [Guarantees & Limitations](#guarantees--limitations)

---

## Features

- **Loop Detection** — Stops agents repeating identical tool calls
- **Hard Budget Limits** — Per call, per trace, and per workflow
- **PII Protection** — Detects, redacts, or blocks sensitive data
- **Retry & Fallback** — Automatic fallback across providers
- **In-Process** — No proxy, no extra network hop, near-zero latency

---

## Why Loret

Most guardrail solutions add latency and complexity. Loret runs inside your application, so it's fast, private, and simple to use.

| | Loret | Proxy-based solutions |
|---|---|---|
| Latency | Near-zero (in-process) | Extra network hop |
| Privacy | Data stays in your app — no phone home | Data passes through third party |
| Setup | `npm install` + config | Deploy and maintain a proxy |
| Loop detection | Deterministic fingerprinting | Varies |

---

## How It Works

Loret sits directly inside your process and watches every tool call your agent makes.

```
App → Loret → Guardrails → Routing → Provider
```

It automatically:

- Detects repeating tool calls (loops)
- Enforces hard budget limits
- Stops the agent and gives you a clear reason why

All in-process. No proxy. No added network hop.

---

## Installation

```bash
npm install @loret/sdk
```

---

## Configuration

```ts
const loret = new Loret({
  projectId: "my-agent",
  mode: "enforce",                        // "monitor" or "enforce"
  adapters: [
    new OpenAIAdapter(process.env.OPENAI_API_KEY!),
    new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!),
  ],
  providers: [
    { provider: "openai",    model: "gpt-4o-mini",   priority: 1 },
    { provider: "anthropic", model: "claude-haiku",   priority: 2 },
  ],
  budgetLimits: [
    { scope: "per_call", maxCostUsd: 0.05 },
  ],
  loopGuards: {
    classAConsecutive: 3,                 // block after 3 identical calls
  },
});
```

**Adapters** connect Loret to a provider's API (`OpenAIAdapter`, `AnthropicAdapter`). **Providers** define which models to use and in what order — Loret routes and falls back automatically.

See the full [configuration reference](packages/sdk/README.md#configuration-reference) for all options.

---

## Examples

### Agent loop detection

This simulates an agent stuck in a loop — Loret detects it and returns a structured recovery plan. Costs < $0.01.

```ts
import { Loret } from "@loret/sdk";
import { OpenAIAdapter } from "@loret/sdk/providers/openai";
import type { LoopSignal } from "@loret/sdk";

const client = new Loret({
  projectId: "demo",
  adapters: [new OpenAIAdapter(process.env.OPENAI_API_KEY!)],
  providers: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
  mode: "enforce",
  workflowGuards: { maxCallsPerWorkflow: 10, maxCostPerWorkflowUsd: 0.50 },
  loopGuards: { classAConsecutive: 3 },
});

const stuckSignal: LoopSignal = {
  toolName: "search_db",
  toolArgs: '{"q":"users"}',
  toolResult: "[]",
  resultStatus: "empty",
};

for (let turn = 1; turn <= 6; turn++) {
  const r = await client.run({
    messages: [{ role: "user", content: "Find user records." }],
    maxTokens: 50,
    metadata: { traceId: "demo-1" },
    loopSignal: stuckSignal,
  });
  if (r.blocked) {
    console.log(`Turn ${turn}: BLOCKED — ${r.recovery!.suggestion}`);
    break;
  }
  console.log(`Turn ${turn}: allowed ($${r.usage.estimatedCostUsd.toFixed(4)})`);
}
await client.shutdown();
```

Turns 1–3 go through. Turn 4 returns a blocked result with a recovery plan — your agent can use `r.recovery.suggestion` to try a different approach.

### How loop detection works

**Class A — Exact Stagnation**
Same tool + same inputs + same result across consecutive turns → blocked deterministically

**Class B — Unsuccessful Exploration**
Same tool + different inputs + repeated empty/error results → tracked as suspicion (does not block alone)

No embeddings, no LLM calls, no semantic guesswork. Deterministic and fast.

---

## Error Handling

All errors extend `LoretError` and expose a `code` field for structured handling.

| Error | When |
|---|---|
| `BudgetExceededError` | Budget limit reached |
| `LoopGuardExceededError` | Loop detected (Class A) |
| `PiiBlockedError` | PII detected in block mode |
| `AllProvidersFailedError` | All providers exhausted after retries |
| `WorkflowGuardExceededError` | Workflow guard limit reached |
| `TraceGuardExceededError` | Trace guard limit reached |

In `"monitor"` mode, violations emit telemetry but the request proceeds. In `"enforce"` mode, violations throw.

---

## Telemetry & Observability

Loret emits structured events asynchronously — non-blocking, fire-and-forget. Telemetry never adds latency to request execution.

Use `"monitor"` mode to observe guardrail behavior in production before enabling enforcement:

```ts
const loret = new Loret({
  // ...
  mode: "monitor",
});

// Violations emit telemetry but the request still goes through:
// {
//   type: "loop_guard_blocked",
//   projectId: "my-agent",
//   traceId: "workflow-1",
//   guardDimension: "class_a",
//   timestamp: "2026-04-24T14:32:01.000Z"
// }
```

Emitted events: `request_started`, `request_completed`, `request_failed`, `fallback_triggered`, `budget_blocked`, `loop_guard_blocked`, `privacy_detected`, and more.

Call `client.shutdown()` before process exit to flush buffered events.

> **Coming soon:** A pluggable observability API (`loret.on("violation", ...)`) for piping events directly to Datadog, Grafana, or your own logger. See [Roadmap](#roadmap).

---

## Roadmap

**v1.0.2 (current):** Structured loop recovery — when Loret blocks a loop, `run()` returns a recovery plan instead of only throwing.

**Next:**

- **Pluggable observability** — `loret.on("violation", ...)` to pipe events to Datadog, Grafana, or your own logger
- **Response caching** — skip duplicate prompt+model calls
- **Streaming support** — `client.stream()` with guard enforcement
- **Semantic loop detection** — catch paraphrased loops, not just exact repeats

[Vote or suggest features →](https://github.com/loret-sdk/sdk/discussions)

---

## Guarantees & Limitations

- Cost is estimated pre-dispatch (not billing-accurate)
- PII detection is pattern-based (not semantic)
- Budget limits are per process unless backed by external state

These are deliberate tradeoffs that keep the runtime fast, predictable, and reliable.

---

See the full [SDK documentation](packages/sdk/README.md) for deployment guarantees, telemetry, testing utilities, and API reference.

## License

MIT
