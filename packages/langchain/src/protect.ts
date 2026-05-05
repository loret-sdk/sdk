import { LoretCallbackHandler } from "./handler.js";
import type { LoretHandlerOptions, LoopRecoveryContext } from "./handler.js";

export interface GuardOptions {
  classAConsecutive?: number;
  classBSuspicion?: number;
  classBToolWindow?: number;
  classBDistinctArgs?: number;
  windowSize?: number;
  verbose?: boolean;
  maxCostUsd?: number;
  onBlocked?: (reason: string) => void;
  onFinalWarning?: (reason: string) => void;
  onHardStop?: (reason: string) => void;
  recoveryMessage?: string | ((ctx: LoopRecoveryContext) => string);
}

function toHandlerOptions(opts: GuardOptions): LoretHandlerOptions {
  const {
    classAConsecutive, classBSuspicion, classBToolWindow,
    classBDistinctArgs, windowSize, ...rest
  } = opts;
  const loopGuards = { classAConsecutive, classBSuspicion, classBToolWindow, classBDistinctArgs, windowSize };
  const hasGuards = Object.values(loopGuards).some(v => v !== undefined);
  return { ...rest, loopGuards: hasGuards ? loopGuards : { classAConsecutive: 3 } };
}

export function guard(
  factory: (config: any) => any,
  config: { tools: any[]; [key: string]: any },
  options: GuardOptions = {},
): any {
  const handler = new LoretCallbackHandler(toHandlerOptions(options));
  const wrappedTools = handler.wrapTools([...config.tools]);
  const agent = factory({ ...config, tools: wrappedTools });

  const originalInvoke = agent.invoke.bind(agent);
  agent.invoke = async (input: any, runConfig?: any) => {
    const result = await originalInvoke(input, {
      ...runConfig,
      callbacks: [...(runConfig?.callbacks ?? []), handler],
    });
    handler.printSummary();
    return result;
  };

  return agent;
}
