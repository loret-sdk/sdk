# @loret/sdk

> The runtime reliability layer for AI agents.

Stops repeated tool-call loops, prevents silent task failure, and runs in-process with near-zero latency.

See the full [documentation and examples](../../README.md).

## Quick Start

```bash
npm install @loret/sdk
```

```ts
import { loret } from "@loret/sdk";

const session = loret();
const safeCheck = session.guard(checkHealth);

const result = await safeCheck("payments-api");
session.reset(); // clear loop state at end of run
```

For LangChain or Vercel AI SDK, see [`@loret/langchain`](../langchain/README.md) and [`@loret/vercel`](../vercel/README.md).

## Advanced Configuration

```ts
const session = loret({
  classAConsecutive: 3,    // identical calls before block (default: 3)
  classBSuspicion: 4,      // failures before block (default: 4)
  classBToolWindow: 6,     // per-tool sliding window (default: 6)
  classBDistinctArgs: 2,   // min distinct args for Class B (default: 2)
  windowSize: 12,          // global sliding window (default: 12)
  verbose: true,           // console output (default: true)
  onBlocked: (toolName, reason) => {},
  onHardStop: (toolName, reason) => {},
});
```

## Example: detecting a loop

```ts
import { loret } from "@loret/sdk";

const session = loret({ verbose: false });

const safeTool = session.guard("searchWeb", async (query: string) => {
  return []; // simulate empty results
});

const result = await safeTool("failing query");
session.reset();
```

## License

MIT
