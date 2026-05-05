# @loret/vercel

> Drop-in loop detection and recovery for Vercel AI SDK agents.

A stuck agent doesn't just waste money — it fails the task. `@loret/vercel` detects repeated tool-call loops and breaks the loop so the agent can recover or escalate.

- Works with any Vercel AI SDK model provider
- Detects identical repeated calls deterministically
- Injects recovery instead of crashing the agent

## Install

```bash
npm install @loret/vercel @loret/sdk ai
```

## Usage

```ts
import { guard } from "@loret/vercel";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = await guard(openai("gpt-4.1"));

const result = await generateText({
  model,
  tools,
  prompt: "Deploy payments-api v2.4.1 and confirm it's healthy.",
});
```

When the agent loops (same tool, same args, same result), Loret replaces the last tool result with a recovery message. The agent reads it and changes approach — no crash, no manual intervention.

## Advanced

For custom thresholds, recovery messages, or lifecycle hooks, use `loretMiddleware` directly:

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

## Options

```ts
await guard(model, {
  classAConsecutive: 3,    // block after N identical consecutive calls
  classBSuspicion: 4,      // block after N failures with different args
  verbose: true,           // log detection events and run summary (default: true)
  onBlocked: (reason) => {},
  onHardStop: (reason) => {},
  recoveryMessage: "Try a different approach.",
});
```

## License

MIT
