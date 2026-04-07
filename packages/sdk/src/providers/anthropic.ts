import Anthropic from "@anthropic-ai/sdk";
import type { ProviderCallInput, ProviderCallResult } from "../shared";

import { ProviderError, type ProviderAdapter } from "./adapter.js";

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("AnthropicAdapter: apiKey is required");
    }
    this.client = new Anthropic({ apiKey });
  }

  async call(input: ProviderCallInput, signal?: AbortSignal): Promise<ProviderCallResult> {
    const startedAt = Date.now();
    const requestSignal = composeSignal(signal, input.timeoutMs);

    // Anthropic separates system prompts from the messages array.
    const systemContent = input.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const chatMessages: Anthropic.MessageParam[] = input.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    try {
      const response = await this.client.messages.create(
        {
          model: input.model,
          max_tokens: input.maxTokens ?? 1024,
          ...(systemContent ? { system: systemContent } : {}),
          messages: chatMessages,
        },
        requestSignal ? { signal: requestSignal } : undefined,
      );

      const first = response.content[0];
      const content = first?.type === "text" ? first.text : "";
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      return {
        type: "buffered",
        content,
        usage: {
          inputTokens,
          outputTokens,
          estimatedCostUsd: estimateAnthropicCost(input.model, inputTokens, outputTokens),
        },
        latencyMs: Date.now() - startedAt,
        provider: this.name,
        model: input.model,
      };
    } catch (error) {
      throw normalizeAnthropicError(error, requestSignal);
    }
  }
}

function estimateAnthropicCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getPricing(model);
  const inputCost = (inputTokens / 1000) * pricing.inputPer1kUsd;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1kUsd;
  return roundUsd(inputCost + outputCost);
}

function getPricing(model: string): { inputPer1kUsd: number; outputPer1kUsd: number } {
  if (model.includes("haiku")) return { inputPer1kUsd: 0.0008, outputPer1kUsd: 0.004 };
  if (model.includes("sonnet")) return { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 };
  // Conservative fallback for unknown Anthropic models.
  return { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeAnthropicError(error: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted) return new ProviderError("timeout", "Anthropic request aborted", true);

  const e = error as { status?: number; message?: string; name?: string };
  const message = e?.message ?? "Anthropic provider call failed";
  const statusError = errorFromStatus(e?.status, message);
  if (statusError) return statusError;

  if (e?.name === "AbortError" || e?.name === "APIConnectionTimeoutError") {
    return new ProviderError("timeout", message, true);
  }
  return new ProviderError("anthropic_error", message, false);
}

function errorFromStatus(status: number | undefined, message: string): ProviderError | null {
  if (status === 401 || status === 403) return new ProviderError("auth_error", message, false);
  if (status === 429) return new ProviderError("rate_limited", message, true);
  if (status !== undefined && status >= 500) return new ProviderError("server_error", message, true);
  return null;
}

function composeSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  const timeoutSignal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  if (!parent) return timeoutSignal;
  if (!timeoutSignal) return parent;

  const controller = new AbortController();

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (parent.aborted || timeoutSignal.aborted) {
    abort();
    return controller.signal;
  }

  parent.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });

  return controller.signal;
}
