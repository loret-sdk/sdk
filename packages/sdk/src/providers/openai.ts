import OpenAI from "openai";
import type { ProviderCallInput, ProviderCallResult } from "../shared";

import { ProviderError, type ProviderAdapter } from "./adapter.js";

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  private readonly client: OpenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("OpenAIAdapter: apiKey is required");
    }

    this.client = new OpenAI({ apiKey });
  }

  async call(input: ProviderCallInput, signal?: AbortSignal): Promise<ProviderCallResult> {
    const startedAt = Date.now();
    const requestSignal = composeSignal(signal, input.timeoutMs);

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: input.model,
          messages: [...input.messages],
          max_tokens: input.maxTokens,
        },
        requestSignal ? { signal: requestSignal } : undefined,
      );

      const content = completion.choices[0]?.message?.content ?? "";
      const inputTokens = completion.usage?.prompt_tokens ?? 0;
      const outputTokens = completion.usage?.completion_tokens ?? 0;

      return {
        type: "buffered",
        content,
        usage: {
          inputTokens,
          outputTokens,
          estimatedCostUsd: estimateOpenAICost(input.model, inputTokens, outputTokens),
        },
        latencyMs: Date.now() - startedAt,
        provider: this.name,
        model: input.model,
      };
    } catch (error) {
      throw normalizeOpenAIError(error, requestSignal);
    }
  }
}

function estimateOpenAICost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getPricing(model);

  const inputCost = (inputTokens / 1000) * pricing.inputPer1kUsd;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1kUsd;

  return roundUsd(inputCost + outputCost);
}

function getPricing(model: string): {
  inputPer1kUsd: number;
  outputPer1kUsd: number;
} {
  if (model.includes("gpt-4o-mini")) {
    return { inputPer1kUsd: 0.00015, outputPer1kUsd: 0.0006 };
  }

  if (model.includes("gpt-4o")) {
    return { inputPer1kUsd: 0.005, outputPer1kUsd: 0.015 };
  }

  // Conservative fallback for unknown OpenAI chat models.
  return { inputPer1kUsd: 0.005, outputPer1kUsd: 0.015 };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeOpenAIError(error: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted) return new ProviderError("timeout", "OpenAI request aborted", true);

  const e = error as { status?: number; code?: string; message?: string; name?: string };
  const message = e?.message ?? "OpenAI provider call failed";
  const statusError = errorFromStatus(e?.status, message);
  if (statusError) return statusError;

  const code = e?.code ?? "openai_error";
  if (isTimeoutCode(code, e?.name)) return new ProviderError("timeout", message, true);
  return new ProviderError(code, message, false);
}

function isTimeoutCode(code: string, name: string | undefined): boolean {
  return code === "ETIMEDOUT" || code === "timeout" || name === "AbortError";
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
