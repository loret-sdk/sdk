# Loret

**Runtime policy layer for LLM applications — enforce cost, privacy, and runtime guardrails on every model call.**

Loret is an in-process policy layer that evaluates every model call before provider dispatch. It enforces budgets, prevents agent loops, controls PII, routes failures, and emits telemetry — with no proxy or external service.

---

## Why

Calling an LLM is easy. Operating it in production is not.

- Costs grow unpredictably
- Agents get stuck in loops and burn tokens
- Providers fail or rate limit
- Sensitive data leaks into prompts
- Failures are hard to observe

Without a control layer, cost limits only exist on paper. Loret makes every `run()` call pass through policy enforcement before a single token is spent.

---

## How It Works

```
App → Loret → Guardrails → Routing → Provider
```

Every request is:

- Evaluated against budget, privacy, and runtime rules
- Checked for loop patterns from prior tool activity
- Routed with retry and fallback across configured providers
- Observed via async telemetry

All in-process. No proxy. No added network hop.

---

## Agent Loop Protection

Loret detects and stops agents that get stuck in repeated tool calls.

### Two patterns are tracked

**Class A — Exact Stagnation**
Same tool + same inputs + same result across consecutive turns
→ **blocked deterministically**

**Class B — Unsuccessful Exploration**
Same tool + different inputs + repeated empty/error results
→ tracked as suspicion (does not block alone)

### Default behavior

- Blocks after **3 consecutive stagnation turns** (within a window of 5)
- Suspicion decays when progress resumes
- No embeddings, no LLM calls, no semantic guesswork

> Deterministic. Fast. Explicit blocking criteria.

---

## Quick Start

```bash
npm install @loret/sdk
```

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

See the full [SDK README](packages/sdk/README.md) for configuration, deployment guarantees, and API reference.

---

## Core Capabilities

- Enforce cost budgets before execution
- Detect and stop agent loops deterministically
- Apply runtime guardrails (cost, duration, call count)
- Detect and control PII in prompts
- Retry and fallback across providers
- Emit structured telemetry without blocking

---

## Key Concepts

**Adapters** connect Loret to a provider's API (`OpenAIAdapter`, `AnthropicAdapter`). You register one adapter per provider.

**Providers** define which models to use and in what order. Loret routes and falls back automatically.

```ts
adapters: [
  new OpenAIAdapter({ apiKey: "..." }),
  new AnthropicAdapter({ apiKey: "..." }),
],
providers: [
  { provider: "openai",    model: "gpt-4o-mini",   priority: 1 },
  { provider: "anthropic", model: "claude-haiku",   priority: 2 },
],
```

---

## Design Principles

- **Pre-dispatch control** — decisions happen before cost is incurred
- **Deterministic enforcement** — no model calls for guardrails
- **In-process execution** — zero added network latency
- **Explicit behavior** — no hidden retries or silent failures

---

## Tradeoffs

- Cost is estimated pre-dispatch (not billing-accurate)
- PII detection is pattern-based (not semantic)
- Budget limits are per process unless backed by external state

These tradeoffs keep the runtime fast, predictable, and reliable.

---

## Documentation

See the full [SDK README](packages/sdk/README.md) for configuration, deployment guarantees, and API reference.

## License

MIT
