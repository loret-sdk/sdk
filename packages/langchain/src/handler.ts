import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { LoopGuardStore } from "@loret/sdk";
import type { LoopGuards } from "@loret/sdk";

export interface LoopRecoveryContext {
  toolName: string;
  toolArgs: string;
  dimension: "class_a" | "class_b";
  consecutiveCount: number;
  failureCount: number;
  resultStatus: "success" | "empty" | "error";
}

export interface LoretHandlerOptions {
  /** Budget ceiling in USD across the entire agent run. */
  maxCostUsd?: number;
  /** Loop guard configuration. Default: { classAConsecutive: 3 } */
  loopGuards?: LoopGuards;
  /** Print status lines to console. Default: true. */
  verbose?: boolean;
  /** Called when the handler blocks the agent. */
  onBlocked?: (reason: string) => void;
  /** Called when the agent ignores recovery — final warning delivered. */
  onFinalWarning?: (reason: string) => void;
  /** Called when the agent is terminated after ignoring the final warning. */
  onHardStop?: (reason: string) => void;
  /** Custom recovery message. Pass a string with {{toolName}}, {{consecutiveCount}}, {{resultStatus}} placeholders, or a function for full control. */
  recoveryMessage?: string | ((ctx: LoopRecoveryContext) => string);
}

interface PendingTool {
  name: string;
  input: string;
  runId: string;
}

export class LoretCallbackHandler extends BaseCallbackHandler {
  name = "LoretCallbackHandler";

  private readonly maxCostUsd: number | undefined;
  private readonly loopGuards: LoopGuards;
  private readonly verbose: boolean;
  private readonly onBlocked: ((reason: string) => void) | undefined;
  private readonly onFinalWarning: ((reason: string) => void) | undefined;
  private readonly onHardStop: ((reason: string) => void) | undefined;
  private readonly customRecovery: string | ((ctx: LoopRecoveryContext) => string) | undefined;

  private readonly loopStore = new LoopGuardStore();
  private readonly pending = new Map<string, PendingTool>();

  private traceId: string | undefined;
  private totalCostUsd = 0;
  private toolCallCount = 0;
  private blockedToolCalls = 0;
  private loopsCaught = 0;
  private hardStops = 0;
  private blockedReason: string | undefined;
  private recoveryMessage: string | undefined;
  private recoveryDelivered = false;
  private finalWarningMessage: string | undefined;
  private finalWarningDelivered = false;
  private blockAllTools = false;

  constructor(options: LoretHandlerOptions = {}) {
    super();
    this.maxCostUsd = options.maxCostUsd;
    this.loopGuards = options.loopGuards ?? { classAConsecutive: 3 };
    this.verbose = options.verbose ?? true;
    this.onBlocked = options.onBlocked;
    this.onFinalWarning = options.onFinalWarning;
    this.onHardStop = options.onHardStop;
    this.customRecovery = options.recoveryMessage;
  }

  get blocked(): boolean {
    return this.blockedReason !== undefined;
  }

  checkBlocked(): void {
    if (this.blockedReason) {
      throw new Error(this.blockedReason);
    }
  }

  async handleChainStart(
    _chain: Serialized,
    _inputs: Record<string, unknown>,
    runId: string,
  ): Promise<void> {
    if (!this.traceId) {
      this.traceId = runId;
    }
  }

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const toolName = runName || (tool.id?.[tool.id.length - 1] ?? "unknown");
    this.pending.set(runId, { name: toolName, input, runId });
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    const tool = this.pending.get(runId);
    if (!tool) return;
    this.pending.delete(runId);

    if (this.recoveryDelivered || this.finalWarningDelivered || this.blockAllTools) {
      this.blockedToolCalls++;
      this.recoveryDelivered = false;
      return;
    }

    this.toolCallCount++;

    const outputStr = coerceToString(output);
    const resultStatus = classifyResult(outputStr);
    const traceId = this.traceId ?? "default";

    const result = this.loopStore.check(
      traceId,
      {
        toolName: tool.name,
        toolArgs: tool.input,
        toolResult: outputStr,
        resultStatus,
      },
      this.loopGuards,
    );

    if (!result.allowed) {
      if (result.dimension === "hard_stop") {
        const reason = `Loret: final warning — ${result.reason}`;
        this.onFinalWarning?.(reason);
        this.finalWarningMessage = buildFinalWarningMessage(tool.name);
        if (this.verbose) console.log(`⚠️  [Loret] Final warning: ${tool.name}() called after recovery`);
        return;
      }
      const ctx: LoopRecoveryContext = {
        toolName: tool.name,
        toolArgs: tool.input,
        dimension: result.dimension as "class_a" | "class_b",
        consecutiveCount: result.consecutiveClassA,
        failureCount: result.suspicion,
        resultStatus,
      };
      this.loopsCaught++;
      this.block(
        `Loret: loop detected — ${result.reason}`,
        resolveRecovery(this.customRecovery, ctx),
      );
      if (this.verbose) {
        const detail = result.dimension === "class_a"
          ? `${result.consecutiveClassA} consecutive calls with same args`
          : `${result.suspicion} failures with different approaches`;
        console.log(`\n🔄 [Loret] Loop detected: ${tool.name}() (${detail})`);
      }
    }
  }

  async handleToolError(_err: Error, runId: string): Promise<void> {
    const tool = this.pending.get(runId);
    if (!tool) return;
    this.pending.delete(runId);

    if (this.recoveryDelivered || this.finalWarningDelivered || this.blockAllTools) {
      this.blockedToolCalls++;
      this.recoveryDelivered = false;
      return;
    }

    this.toolCallCount++;

    const traceId = this.traceId ?? "default";

    const result = this.loopStore.check(
      traceId,
      {
        toolName: tool.name,
        toolArgs: tool.input,
        toolResult: _err.message,
        resultStatus: "error",
      },
      this.loopGuards,
    );

    if (!result.allowed) {
      if (result.dimension === "hard_stop") {
        const reason = `Loret: final warning — ${result.reason}`;
        this.onFinalWarning?.(reason);
        this.finalWarningMessage = buildFinalWarningMessage(tool.name);
        if (this.verbose) console.log(`⚠️  [Loret] Final warning: ${tool.name}() called after recovery`);
        return;
      }
      const ctx: LoopRecoveryContext = {
        toolName: tool.name,
        toolArgs: tool.input,
        dimension: result.dimension as "class_a" | "class_b",
        consecutiveCount: result.consecutiveClassA,
        failureCount: result.suspicion,
        resultStatus: "error",
      };
      this.loopsCaught++;
      this.block(
        `Loret: loop detected — ${result.reason}`,
        resolveRecovery(this.customRecovery, ctx),
      );
      if (this.verbose) {
        const detail = result.dimension === "class_a"
          ? `${result.consecutiveClassA} consecutive calls with same args`
          : `${result.suspicion} failures with different approaches`;
        console.log(`\n🔄 [Loret] Loop detected: ${tool.name}() (${detail})`);
      }
    }
  }

  async handleLLMStart(
    _llm: Serialized,
    _prompts: string[],
  ): Promise<void> {
    this.blockAllTools = false;
  }

  async handleLLMEnd(output: LLMResult): Promise<void> {
    if (!this.maxCostUsd) return;

    const usage = output.llmOutput?.tokenUsage as
      | { totalTokens?: number; promptTokens?: number; completionTokens?: number }
      | undefined;

    if (usage) {
      const input = usage.promptTokens ?? 0;
      const output = usage.completionTokens ?? 0;
      this.totalCostUsd += (input / 1000) * 0.005 + (output / 1000) * 0.015;
    }

    if (this.totalCostUsd >= this.maxCostUsd) {
      this.block(
        `Loret: budget exceeded — $${this.totalCostUsd.toFixed(4)} >= $${this.maxCostUsd}`,
        `[LORET] Budget limit reached ($${this.totalCostUsd.toFixed(4)} of $${this.maxCostUsd} max). ` +
        `Do not make any more tool calls. Inform the user that the operation was stopped to prevent excessive costs.`,
      );
    }
  }

  private block(reason: string, recovery?: string): void {
    this.blockedReason = reason;
    this.recoveryMessage = recovery;
    this.onBlocked?.(reason);
  }

  getTotalCostUsd(): number {
    return this.totalCostUsd;
  }

  wrapTools<T extends { _call: (...args: any[]) => any }>(tools: T[]): T[] {
    const handler = this;
    for (const t of tools) {
      const original = t._call.bind(t);
      t._call = async function (...args: any[]) {
        if (handler.finalWarningDelivered) {
          const reason = "Loret: agent terminated — called tools after final warning";
          handler.hardStops++;
          handler.onHardStop?.(reason);
          if (handler.verbose) console.log(`🛑 [Loret] Agent terminated: ignored final warning`);
          throw new Error(reason);
        }
        if (handler.finalWarningMessage) {
          const msg = handler.finalWarningMessage;
          handler.finalWarningMessage = undefined;
          handler.finalWarningDelivered = true;
          return msg;
        }
        if (handler.recoveryMessage) {
          const msg = handler.recoveryMessage;
          handler.recoveryMessage = undefined;
          handler.blockedReason = undefined;
          handler.recoveryDelivered = true;
          handler.blockAllTools = true;
          return msg;
        }
        if (handler.blockAllTools) {
          return "[LORET] Tool call blocked — a loop was detected. Do NOT call any more tools. Respond with text only.";
        }
        return original(...args);
      };
    }
    return tools;
  }

  reset(): void {
    this.totalCostUsd = 0;
    this.traceId = undefined;
    this.blockedReason = undefined;
    this.recoveryMessage = undefined;
    this.blockAllTools = false;
    this.blockedToolCalls = 0;
    this.pending.clear();
    this.loopStore.shutdown();
  }

  printSummary(): void {
    if (!this.verbose || (this.toolCallCount === 0 && this.blockedToolCalls === 0)) return;
    const status = this.hardStops > 0
      ? "Agent terminated"
      : this.loopsCaught > 0
        ? "Recovery successful"
        : "Clean run";
    const savedCalls = this.loopsCaught * 5;
    const avgCost = this.toolCallCount > 0 && this.totalCostUsd > 0
      ? this.totalCostUsd / this.toolCallCount
      : 0;
    const savedCost = savedCalls * avgCost;
    const blocked = this.blockedToolCalls > 0 ? `, ${this.blockedToolCalls} blocked` : ``;
    const lines = [
      ``,
      `✅ [Loret] Run completed`,
      `   • Tool calls: ${this.toolCallCount} executed${blocked}`,
      `   • Loops caught: ${this.loopsCaught}`,
    ];
    if (this.loopsCaught > 0) {
      lines.push(`   • Actions taken: ${this.loopsCaught} recovery`);
      const costStr = savedCost > 0 ? ` (~$${savedCost.toFixed(2)})` : ``;
      lines.push(`   • Estimated savings: ~${savedCalls} calls${costStr}`);
    }
    lines.push(`   • Final status: ${status}`);
    console.log(lines.join('\n'));
  }
}

function coerceToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (typeof output === "object" && "content" in output) {
    const c = (output as Record<string, unknown>).content;
    if (typeof c === "string") return c;
  }
  try { return JSON.stringify(output); } catch { return String(output); }
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

function buildFinalWarningMessage(toolName: string): string {
  return (
    `[FINAL WARNING] You were told to stop calling "${toolName}" but you did it again. ` +
    `The system will terminate your run on the NEXT tool call.\n\n` +
    `You MUST now respond with text only — do NOT call any tools.\n\n` +
    `In your response:\n` +
    `1. Summarize what you learned from the tool calls you already made.\n` +
    `2. Explain what went wrong and why the task could not be completed.\n` +
    `3. Give the user a clear recommendation on what to do next.\n\n` +
    `This is your last chance to provide useful output before being terminated.`
  );
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
    .replace(/\{\{failureCount\}\}/g, String(ctx.failureCount))
    .replace(/\{\{dimension\}\}/g, ctx.dimension)
    .replace(/\{\{resultStatus\}\}/g, ctx.resultStatus);
}

function buildRecoveryMessage(ctx: LoopRecoveryContext): string {
  if (ctx.dimension === "class_b") {
    return (
      `[LOOP DETECTED] "${ctx.toolName}" has failed ${ctx.failureCount} times with different approaches. ` +
      `Every attempt has returned an error — this tool is not going to work for this task.\n\n` +
      `STOP using "${ctx.toolName}" immediately.\n\n` +
      `Required actions:\n` +
      `1. Do NOT call "${ctx.toolName}" again under any circumstances.\n` +
      `2. Review what you have learned from the failures so far.\n` +
      `3. Either use a completely different approach, or tell the user what you tried, what failed, and what you recommend.\n\n` +
      `Execute one of the above right now.`
    );
  }

  return (
    `[LOOP DETECTED] You have called "${ctx.toolName}" ${ctx.consecutiveCount} consecutive times with identical results. ` +
    `This tool is returning the SAME result every time — repeating it will not change the outcome.\n\n` +
    `STOP using "${ctx.toolName}" immediately.\n\n` +
    `Required actions:\n` +
    `1. Do NOT call "${ctx.toolName}" again under any circumstances.\n` +
    `2. Review the previous tool results and the original task.\n` +
    `3. Take a completely different approach using available tools to complete the task.\n` +
    `4. If no viable path remains, tell the user what you tried, what failed, and what you recommend.\n\n` +
    `Execute one of the above right now.`
  );
}
