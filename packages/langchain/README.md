# @loret/langchain

> Drop-in loop detection and recovery for LangChain agents.

A stuck agent doesn't just waste money — it fails the task. `@loret/langchain` detects repeated tool-call loops and breaks the loop so the agent can recover or escalate.

- Wraps your existing LangChain tools
- Detects identical repeated calls deterministically
- Injects recovery instead of crashing the agent

## Install

```bash
npm install @loret/langchain @loret/sdk
```

## Usage

```ts
import { guard } from "@loret/langchain";

const agent = guard(createReactAgent, { llm, tools: [deployService, checkHealth] });
await agent.invoke({ messages });
```

`guard()` wraps your tools, creates the agent, and injects callbacks. When the agent loops (same tool, same args, same result), Loret injects a recovery message as a tool result. The agent reads it and changes approach — no crash, no manual intervention.

## Advanced

For custom thresholds, recovery messages, or lifecycle hooks, use `LoretCallbackHandler` directly:

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

## Options

```ts
guard(factory, config, {
  classAConsecutive: 3,    // block after N identical consecutive calls
  classBSuspicion: 4,      // block after N failures with different args
  verbose: true,           // log detection events and run summary (default: true)
  maxCostUsd: 0.50,        // budget ceiling for the run
  onBlocked: (reason) => {},
  onHardStop: (reason) => {},
  recoveryMessage: "Try a different approach.",
});
```

## Requirements

- `@langchain/core` >= 0.3.0

## License

MIT
