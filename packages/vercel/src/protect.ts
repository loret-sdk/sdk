import { createRequire } from "node:module";
import { loretMiddleware } from "./middleware.js";
import type { LoretMiddlewareOptions, LoopRecoveryContext } from "./middleware.js";

export interface GuardOptions {
  classAConsecutive?: number;
  classBSuspicion?: number;
  classBToolWindow?: number;
  classBDistinctArgs?: number;
  windowSize?: number;
  verbose?: boolean;
  traceId?: string;
  onBlocked?: (reason: string) => void | Promise<void>;
  onFinalWarning?: (reason: string) => void | Promise<void>;
  onHardStop?: (reason: string) => void | Promise<void>;
  recoveryMessage?: string | ((ctx: LoopRecoveryContext) => string);
}

function toMiddlewareOptions(opts: GuardOptions): LoretMiddlewareOptions {
  const {
    classAConsecutive, classBSuspicion, classBToolWindow,
    classBDistinctArgs, windowSize, ...rest
  } = opts;
  const loopGuards = { classAConsecutive, classBSuspicion, classBToolWindow, classBDistinctArgs, windowSize };
  const hasGuards = Object.values(loopGuards).some(v => v !== undefined);
  return { ...rest, loopGuards: hasGuards ? loopGuards : { classAConsecutive: 3 } };
}

export async function guard(
  model: any,
  options: GuardOptions = {},
): Promise<any> {
  let wrapFn: (args: { model: any; middleware: any }) => any;
  try {
    const _require = createRequire(process.cwd() + "/package.json");
    const ai = _require("ai");
    wrapFn = ai.wrapLanguageModel;
  } catch {
    throw new Error(
      '@loret/vercel guard() requires the "ai" package. Run: npm install ai',
    );
  }
  const middleware = loretMiddleware(toMiddlewareOptions(options));
  return wrapFn({ model, middleware });
}
