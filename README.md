# Loret

**Control cost, reliability, and safety of every LLM call — before it leaves your system.**

Loret is a lightweight runtime layer between your application and model providers. It enforces guardrails, prevents agent loops, routes failures, and emits telemetry — all in-process, with no proxy.

---

## Why

Calling an LLM is easy. Operating it in production is not.

- Costs grow unpredictably
- Agents get stuck in loops and burn tokens
- Providers fail or rate limit
- Sensitive data leaks into prompts
- Failures are hard to observe

Loret adds a single control layer that makes LLM execution **predictable, safe, and observable**.

---

## How It Works

```
App → Loret → Guardrails → Routing → Provider
```

Every request is:

- Checked against budget and safety rules
- Evaluated for agent loop patterns
- Processed through guardrails (cost, PII, trace limits)
- Routed with retry and fallback
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

> Deterministic. Fast. Zero false positives.

### Example

An agent retries the same search tool repeatedly:

```
Turn 1 → search("policy 2024")        → empty
Turn 2 → search("policy update 2024") → empty
Turn 3 → search("latest policy 2024") → empty
```

Without Loret → continues looping, burning tokens

With Loret → **blocked at turn 3** with a structured error

---

## Quick Start

```bash
pnpm add @loret/sdk
```

```ts
import { Loret } from "@loret/sdk";
import { OpenAIAdapter } from "@loret/sdk/providers/openai";

const client = new Loret({
  projectId: "my-project",
  adapters: [new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! })],
  providers: [
    { provider: "openai", model: "gpt-4o-mini", priority: 1 },
  ],
});

const result = await client.run({
  messages: [{ role: "user", content: "Explain distributed systems simply." }],
});

console.log(result.content);

await client.shutdown(); // flush telemetry before exit
```

---

## Core Capabilities

- Enforce cost budgets before execution
- Detect and stop agent loops deterministically
- Apply runtime guardrails (cost, duration, retries)
- Detect and control PII in prompts
- Retry and fallback across providers
- Emit structured telemetry without blocking

---

## Key Concepts

**Adapters** wrap a provider's API (`OpenAIAdapter`, `AnthropicAdapter`). You register one adapter per provider.

**Providers** define which models to use and in what order. Loret routes and falls back automatically.

```ts
adapters: [new OpenAIAdapter({ apiKey: "..." })],
providers: [
  { provider: "openai", model: "gpt-4o-mini",   priority: 1 },
  { provider: "openai", model: "gpt-3.5-turbo", priority: 2 },
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

## Philosophy

Model calls should be easy to make — and hard to misuse.

Loret makes LLM execution explicit, controlled, and observable.
