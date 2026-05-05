# Loret

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

**Use Loret if your agents:**
- repeat the same tool calls
- burn budget without making progress
- fail silently instead of escalating clearly
## Table of Contents

- [Features](#features)
- [LangChain Integration](#langchain-integration)
- [Vercel AI SDK Integration](#vercel-ai-sdk-integration)
- [Why Loret](#why-loret)
- [How It Works](#how-it-works)
- [How Loop Detection Works](#how-loop-detection-works)
- [Telemetry & Observability](#telemetry--observability)
- [Error Handling](#error-handling)
- [Roadmap](#roadmap)
- [Guarantees & Limitations](#guarantees--limitations)

---

## Features

- **Loop Detection & Recovery** — Detects repeating tool calls and breaks the loop so the agent can recover or escalate
- **Hard Budget Limits** — Per call, per trace, and per workflow
- **Retry & Fallback** — Automatic fallback across providers
- **Framework Integrations** — Drop-in support for [LangChain](#langchain-integration) and [Vercel AI SDK](#vercel-ai-sdk-integration)
- **PII Protection** — Detects, redacts, or blocks sensitive data
- **In-Process** — No proxy, no extra network hop, near-zero latency

---

## LangChain Integration

```bash
npm install @loret/langchain @loret/sdk
```

```ts
import { guard } from "@loret/langchain";

const agent = guard(createReactAgent, { llm, tools: [deployService, checkHealth] });
await agent.invoke({ messages });
```

`guard()` wraps your tools, creates the agent, and injects callbacks — you just call `.invoke()`. For advanced options (custom recovery messages, budget limits, lifecycle hooks), use `LoretCallbackHandler` directly:

<details>
<summary>Advanced usage</summary>

```ts
import { LoretCallbackHandler } from "@loret/langchain";

const handler = new LoretCallbackHandler({
  loopGuards: { classAConsecutive: 3 },
  onBlocked: (reason) => console.log(reason),
  recoveryMessage: "Try a different approach.",
});

const agent = createReactAgent({
  llm,
  tools: handler.wrapTools([deployService, checkHealth]),
});

await agent.invoke({ messages }, { callbacks: [handler] });
```

</details>

When the agent loops, Loret injects a recovery message as a tool result. The agent reads it and switches tools, changes arguments, or informs the user — instead of retrying forever.

```
check_health("payments-api") → timeout
check_health("payments-api") → timeout
check_health("payments-api") → timeout
check_health("payments-api") → [LORET] Loop detected. Try a different tool.
get_deploy_status("payments-api") → success ✓
"payments-api v2.4.1 is running but health checks are failing on /ready..."
```

Without Loret: 10 calls, task failed. With Loret: 4 + 1 recovery, task completed.

See the full [`@loret/langchain` docs](packages/langchain/README.md).

---

## Vercel AI SDK Integration

```bash
npm install @loret/vercel @loret/sdk ai
```

```ts
import { guard } from "@loret/vercel";

const model = await guard(openai("gpt-4.1"));
const result = await generateText({ model, tools, prompt });
```

`guard()` wraps your model with loop detection middleware — you just pass it to `generateText()`. For advanced options (custom recovery messages, lifecycle hooks), use `loretMiddleware` directly:

<details>
<summary>Advanced usage</summary>

```ts
import { loretMiddleware } from "@loret/vercel";
import { generateText, wrapLanguageModel } from "ai";

const model = wrapLanguageModel({
  model: openai("gpt-4.1"),
  middleware: loretMiddleware({
    loopGuards: { classAConsecutive: 3 },
    onBlocked: (reason) => console.log(reason),
    recoveryMessage: "Try a different approach.",
  }),
});

const result = await generateText({ model, tools, prompt });
```

</details>

Loret intercepts at the prompt level — when a loop is detected, the recovery message is injected before the next LLM call. The agent reads it and changes approach.

See the full [`@loret/vercel` docs](packages/vercel/README.md).

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

## Error Handling

The `guard()` and `loret()` APIs handle loop recovery automatically — loops are resolved, not thrown. If the agent ignores recovery and keeps looping, Loret terminates the run with an error.

For the low-level `Loret` SDK client, all errors extend `LoretError` with a `code` field:

| Error | When |
|---|---|
| `BudgetExceededError` | Budget limit reached |
| `LoopGuardExceededError` | Loop detected |
| `PiiBlockedError` | PII detected in block mode |
| `AllProvidersFailedError` | All providers exhausted after retries |

---

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

<details>
<summary>Structured telemetry (low-level SDK)</summary>

The `Loret` client emits structured events asynchronously for integration with external observability tools:

```ts
const client = new Loret({ mode: "monitor" });

// Emitted events: request_started, request_completed, request_failed,
// fallback_triggered, budget_blocked, loop_guard_blocked, and more.
```

Call `client.shutdown()` before process exit to flush buffered events.

</details>

---

## Roadmap

- **Pluggable observability** — pipe events to Datadog, Grafana, or your own logger
- **Response caching** — skip duplicate prompt+model calls
- **Streaming support** — guard enforcement on streamed responses

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
