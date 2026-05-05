import { LoopGuardStore } from "./guardrails/loop-guard.js";
import type { LoopGuards } from "./shared.js";

export interface LoretSessionOptions {
  classAConsecutive?: number;
  classBSuspicion?: number;
  classBToolWindow?: number;
  classBDistinctArgs?: number;
  windowSize?: number;
  /** Print status lines to console. Default: true. */
  verbose?: boolean;
  onBlocked?: (toolName: string, reason: string) => void;
  onHardStop?: (toolName: string, reason: string) => void;
}

export interface LoretSession {
  guard<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult | string>;
  guard<TArgs extends unknown[], TResult>(
    name: string,
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult | string>;
  reset(): void;
}

function extractGuards(opts: LoretSessionOptions): LoopGuards {
  const { classAConsecutive, classBSuspicion, classBToolWindow, classBDistinctArgs, windowSize } = opts;
  const guards = { classAConsecutive, classBSuspicion, classBToolWindow, classBDistinctArgs, windowSize };
  return Object.values(guards).some(v => v !== undefined) ? guards : { classAConsecutive: 3 };
}

export function loret(options: LoretSessionOptions = {}): LoretSession {
  const guards = extractGuards(options);
  const verbose = options.verbose ?? true;
  const store = new LoopGuardStore();
  const traceId = `loret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let toolCallCount = 0;
  let loopsCaught = 0;
  let hardStops = 0;

  function guard(
    nameOrFn: string | ((...args: any[]) => any),
    maybeFn?: (...args: any[]) => any,
  ) {
    const name = typeof nameOrFn === "string" ? nameOrFn : (nameOrFn.name || "unknown");
    const fn = typeof nameOrFn === "string" ? maybeFn! : nameOrFn;

    return async (...args: any[]): Promise<any> => {
      toolCallCount++;
      const argsStr = args.length > 0 ? JSON.stringify(args) : "";
      let result: any;
      let resultStr: string;
      let resultStatus: "success" | "empty" | "error";

      try {
        result = await fn(...args);
        resultStr = typeof result === "string" ? result : JSON.stringify(result ?? null);
        resultStatus = classifyResult(resultStr);
      } catch (err: any) {
        resultStr = err?.message ?? "error";
        resultStatus = "error";
        const check = store.check(traceId, {
          toolName: name,
          toolArgs: argsStr,
          toolResult: resultStr,
          resultStatus,
        }, guards);
        if (!check.allowed) {
          if (check.dimension === "hard_stop") {
            hardStops++;
            if (verbose) console.log(`🛑 [Loret] Agent terminated: ${name}() called after recovery`);
            options.onHardStop?.(name, check.reason);
            throw new Error(`[LORET] ${check.reason}`);
          }
          loopsCaught++;
          if (verbose) {
            const detail = check.dimension === "class_a"
              ? `${check.consecutiveClassA} consecutive calls with same args`
              : `${check.suspicion} failures with different approaches`;
            console.log(`\n🔄 [Loret] Loop detected: ${name}() (${detail})`);
          }
          options.onBlocked?.(name, check.reason);
          return recoveryMsg(name, check.dimension as "class_a" | "class_b", check.consecutiveClassA, check.suspicion);
        }
        throw err;
      }

      const check = store.check(traceId, {
        toolName: name,
        toolArgs: argsStr,
        toolResult: resultStr,
        resultStatus,
      }, guards);

      if (!check.allowed) {
        if (check.dimension === "hard_stop") {
          hardStops++;
          if (verbose) console.log(`🛑 [Loret] Agent terminated: ${name}() called after recovery`);
          options.onHardStop?.(name, check.reason);
          throw new Error(`[LORET] ${check.reason}`);
        }
        loopsCaught++;
        if (verbose) {
          const detail = check.dimension === "class_a"
            ? `${check.consecutiveClassA} consecutive calls with same args`
            : `${check.suspicion} failures with different approaches`;
          console.log(`\n🔄 [Loret] Loop detected: ${name}() (${detail})`);
        }
        options.onBlocked?.(name, check.reason);
        return recoveryMsg(name, check.dimension as "class_a" | "class_b", check.consecutiveClassA, check.suspicion);
      }

      return result;
    };
  }

  function printSummary(): void {
    if (!verbose || toolCallCount === 0) return;
    const status = hardStops > 0
      ? "Agent terminated"
      : loopsCaught > 0
        ? "Recovery successful"
        : "Clean run";
    const savedCalls = loopsCaught * 5;
    const lines = [
      ``,
      `✅ [Loret] Run completed`,
      `   • Total tool calls: ${toolCallCount}`,
      `   • Loops caught: ${loopsCaught}`,
    ];
    if (loopsCaught > 0) {
      lines.push(`   • Actions taken: ${loopsCaught} recovery`);
      lines.push(`   • Estimated savings: ~${savedCalls} calls`);
    }
    lines.push(`   • Final status: ${status}`);
    console.log(lines.join('\n'));
  }

  return {
    guard: guard as LoretSession["guard"],
    reset() {
      printSummary();
      store.evictWorkflow(traceId);
      toolCallCount = 0;
      loopsCaught = 0;
      hardStops = 0;
    },
  };
}

function classifyResult(output: string): "success" | "empty" | "error" {
  if (!output || output === "[]" || output === "{}" || output === "null" || output === "undefined") return "empty";
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && "error" in parsed) return "error";
  } catch {}
  return "success";
}

function recoveryMsg(toolName: string, dimension: "class_a" | "class_b", consecutive: number, failures: number): string {
  if (dimension === "class_b") {
    return `[LOOP DETECTED] "${toolName}" has failed ${failures} times. This tool is not working — try a different approach.`;
  }
  return `[LOOP DETECTED] "${toolName}" called ${consecutive} times with identical results. Try a different tool or approach.`;
}
