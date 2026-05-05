import { LoopGuardStore } from "@loret/sdk";
import type { LoopGuards } from "@loret/sdk";
import type {
  LanguageModelV3Middleware,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";

export interface LoopRecoveryContext {
  toolName: string;
  toolArgs: string;
  consecutiveCount: number;
  resultStatus: "success" | "empty" | "error";
  originalTask: string;
}

export interface LoretMiddlewareOptions {
  traceId?: string;
  loopGuards?: LoopGuards;
  /** Print status lines to console. Default: true. */
  verbose?: boolean;
  onBlocked?: (reason: string) => void | Promise<void>;
  onFinalWarning?: (reason: string) => void | Promise<void>;
  onHardStop?: (reason: string) => void | Promise<void>;
  /** Custom recovery message. Pass a string with {{toolName}}, {{consecutiveCount}}, {{resultStatus}}, {{originalTask}} placeholders, or a function for full control. */
  recoveryMessage?: string | ((ctx: LoopRecoveryContext) => string);
}

export function mergeLoopGuards(
  defaults: LoopGuards,
  overrides?: LoopGuards,
): LoopGuards {
  if (!overrides) return defaults;
  return {
    classAConsecutive: overrides.classAConsecutive ?? defaults.classAConsecutive,
    windowSize: overrides.windowSize ?? defaults.windowSize,
  };
}

interface ToolSignal {
  toolName: string;
  toolArgs: string;
  toolResult: string;
  resultStatus: "success" | "empty" | "error";
}

export function loretMiddleware(
  options: LoretMiddlewareOptions = {},
): LanguageModelV3Middleware {
  const traceId = options.traceId ?? `loret-${Date.now()}`;
  const guards = options.loopGuards ?? { classAConsecutive: 3 };
  const verbose = options.verbose ?? true;
  const onBlocked = options.onBlocked;
  const onFinalWarning = options.onFinalWarning;
  const onHardStop = options.onHardStop;
  const customRecovery = options.recoveryMessage;
  const store = new LoopGuardStore();

  let lastCheckedLength = 0;
  let finalWarningDelivered = false;
  let toolCallCount = 0;
  let loopsCaught = 0;

  function extractToolSignals(prompt: LanguageModelV3Prompt): ToolSignal[] {
    const signals: ToolSignal[] = [];
    const pendingCalls = new Map<string, { toolName: string; input: string }>();

    for (const msg of prompt) {
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "tool-call") {
            pendingCalls.set(part.toolCallId, {
              toolName: part.toolName,
              input: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
            });
          }
        }
      } else if (msg.role === "tool") {
        for (const part of msg.content) {
          if (part.type === "tool-result") {
            const call = pendingCalls.get(part.toolCallId);
            if (call) {
              const resultStr = extractOutputText(part.output);
              const isError = part.output.type === "error-text" || part.output.type === "error-json";
              signals.push({
                toolName: call.toolName,
                toolArgs: call.input,
                toolResult: resultStr,
                resultStatus: isError ? "error" : classifyResult(resultStr),
              });
              pendingCalls.delete(part.toolCallId);
            }
          }
        }
      }
    }

    return signals;
  }

  function extractOriginalTask(prompt: LanguageModelV3Prompt): string {
    for (const msg of prompt) {
      if (msg.role === "user") {
        for (const part of msg.content) {
          if (part.type === "text" && part.text) return part.text;
        }
      }
    }
    return "";
  }

  async function checkForLoop(params: LanguageModelV3CallOptions): Promise<string | null> {
    const signals = extractToolSignals(params.prompt);

    if (finalWarningDelivered && signals.length > lastCheckedLength) {
      const reason = "Loret: agent terminated — called tools after final warning";
      await onHardStop?.(reason);
      throw new Error(reason);
    }

    if (signals.length <= lastCheckedLength) return null;

    const newSignals = signals.slice(lastCheckedLength);
    lastCheckedLength = signals.length;
    toolCallCount += newSignals.length;

    for (const signal of newSignals) {
      const result = store.check(traceId, signal, guards);
      if (!result.allowed) {
        if (result.dimension === "hard_stop") {
          const reason = `Loret: final warning — ${result.reason}`;
          await onFinalWarning?.(reason);
          finalWarningDelivered = true;
          if (verbose) console.log(`⚠️  [Loret] Final warning: ${signal.toolName}() called after recovery`);
          const originalTask = extractOriginalTask(params.prompt);
          return buildFinalWarningMessage(signal.toolName, originalTask);
        }

        loopsCaught++;
        const reason = `Loret: loop detected — ${result.reason}`;
        await onBlocked?.(reason);
        if (verbose) {
          const detail = result.dimension === "class_a"
            ? `${result.consecutiveClassA} consecutive calls with same args`
            : `${result.suspicion} failures with different approaches`;
          console.log(`\n🔄 [Loret] Loop detected: ${signal.toolName}() (${detail})`);
        }
        const originalTask = extractOriginalTask(params.prompt);
        const ctx: LoopRecoveryContext = {
          toolName: signal.toolName,
          toolArgs: signal.toolArgs,
          consecutiveCount: result.consecutiveClassA,
          resultStatus: signal.resultStatus,
          originalTask,
        };
        return resolveRecovery(customRecovery, ctx);
      }
    }

    return null;
  }

  function printSummary(): void {
    if (!verbose || toolCallCount === 0) return;
    const status = loopsCaught > 0 ? "Recovery successful" : "Clean run";
    const savedCalls = loopsCaught * 5;
    const lines = [
      ``,
      `✅ [Loret] Run completed`,
      `   • Tool calls: ${toolCallCount} executed`,
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
    specificationVersion: "v3",

    transformParams: async ({ params }) => {
      const recovery = await checkForLoop(params);
      if (recovery) {
        const newPrompt = replaceLastToolResult(params.prompt, recovery);
        return { ...params, prompt: newPrompt };
      }
      return params;
    },

    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      if (result.finishReason.unified !== "tool-calls") {
        printSummary();
      }
      return result;
    },
  };
}

function extractOutputText(output: { type: string; value?: unknown }): string {
  if (output.type === "text" || output.type === "error-text") {
    return String(output.value ?? "");
  }
  if (output.type === "json" || output.type === "error-json") {
    return JSON.stringify(output.value ?? null);
  }
  if (output.type === "execution-denied") {
    return "[execution-denied]";
  }
  if (output.type === "content") {
    const parts = output.value as Array<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function classifyResult(output: string): "success" | "empty" | "error" {
  if (!output || output === "[]" || output === "{}" || output === "null" || output === "undefined") {
    return "empty";
  }
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return "error";
    }
  } catch {}
  return "success";
}

function resolveRecovery(
  custom: string | ((ctx: LoopRecoveryContext) => string) | undefined,
  ctx: LoopRecoveryContext,
): string {
  if (!custom) return buildRecoveryMessage(ctx);
  if (typeof custom === "function") return custom(ctx);
  return custom
    .replace(/\{\{toolName\}\}/g, ctx.toolName)
    .replace(/\{\{consecutiveCount\}\}/g, String(ctx.consecutiveCount))
    .replace(/\{\{resultStatus\}\}/g, ctx.resultStatus)
    .replace(/\{\{originalTask\}\}/g, ctx.originalTask);
}

function replaceLastToolResult(
  prompt: LanguageModelV3Prompt,
  recovery: string,
): LanguageModelV3Prompt {
  const newPrompt = [...prompt];
  for (let i = newPrompt.length - 1; i >= 0; i--) {
    const msg = newPrompt[i];
    if (msg.role === "tool") {
      newPrompt[i] = {
        ...msg,
        content: msg.content.map((part) => {
          if (part.type === "tool-result") {
            return {
              ...part,
              output: { type: "text" as const, value: recovery },
            };
          }
          return part;
        }),
      };
      return newPrompt;
    }
  }
  return newPrompt;
}

function buildFinalWarningMessage(toolName: string, originalTask: string): string {
  const taskLine = originalTask
    ? `\nThe user's original request: "${originalTask}"\n`
    : "";

  return (
    `[FINAL WARNING] You were told to stop calling "${toolName}" but you did it again. ` +
    `The system will terminate your run on the NEXT tool call.\n` +
    `${taskLine}\n` +
    `You MUST now respond with text only — do NOT call any tools.\n\n` +
    `In your response:\n` +
    `1. Summarize what you learned from the tool calls you already made.\n` +
    `2. Explain what went wrong and why the task could not be completed.\n` +
    `3. Give the user a clear recommendation on what to do next.\n\n` +
    `This is your last chance to provide useful output before being terminated.`
  );
}

function buildRecoveryMessage(ctx: LoopRecoveryContext): string {
  const taskLine = ctx.originalTask
    ? `\nOriginal task: "${ctx.originalTask}"\n`
    : "";

  const context = ctx.resultStatus === "error"
    ? `This tool is FAILING repeatedly with the same error.`
    : `This tool is returning the SAME result every time — repeating it will not change the outcome.`;

  return (
    `[LOOP DETECTED] You have called "${ctx.toolName}" ${ctx.consecutiveCount} consecutive times with identical results. ` +
    `${context}` +
    `${taskLine}\n` +
    `You are in a clear loop. Continuing this way is wasteful and will not complete the task.\n\n` +
    `STOP IMMEDIATELY.\n\n` +
    `Required actions:\n` +
    `1. Do NOT call "${ctx.toolName}" again under any circumstances.\n` +
    `2. Review the previous tool results and the original task.\n` +
    `3. Take a completely different approach using available tools to complete the task.\n` +
    `4. If no viable path remains, tell the user what you tried, what failed, and what you recommend.\n\n` +
    `Execute one of the above right now.`
  );
}
