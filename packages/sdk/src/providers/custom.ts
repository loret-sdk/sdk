import type { Message, ProviderCallInput, ProviderCallResult } from "../shared";
import { ProviderError, type ProviderAdapter } from "./adapter.js";

export interface CustomExecuteInput {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface CustomExecuteResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CustomAdapterOptions {
  readonly name: string;
  readonly execute: (input: CustomExecuteInput) => Promise<CustomExecuteResult>;
}

export class CustomAdapter implements ProviderAdapter {
  readonly name: string;

  private readonly execute: CustomAdapterOptions["execute"];

  constructor(options: CustomAdapterOptions) {
    if (!options.name) {
      throw new Error("CustomAdapter: name is required");
    }
    if (!options.execute) {
      throw new Error("CustomAdapter: execute function is required");
    }
    this.name = options.name;
    this.execute = options.execute;
  }

  async call(input: ProviderCallInput, signal?: AbortSignal): Promise<ProviderCallResult> {
    const startedAt = Date.now();
    const requestSignal = composeSignal(signal, input.timeoutMs);

    try {
      const result = await this.execute({
        model: input.model,
        messages: input.messages,
        maxTokens: input.maxTokens,
        signal: requestSignal,
      });

      return {
        type: "buffered",
        content: result.content,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostUsd: 0,
        },
        latencyMs: Date.now() - startedAt,
        provider: this.name,
        model: input.model,
      };
    } catch (error) {
      throw normalizeError(error, this.name, requestSignal);
    }
  }
}

function normalizeError(error: unknown, name: string, signal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted) return new ProviderError("timeout", `${name} request aborted`, true);

  const e = error as { status?: number; message?: string; name?: string };
  const message = e?.message ?? `${name} provider call failed`;

  if (e?.status === 401 || e?.status === 403) return new ProviderError("auth_error", message, false);
  if (e?.status === 429) return new ProviderError("rate_limited", message, true);
  if (e?.status !== undefined && e.status >= 500) return new ProviderError("server_error", message, true);
  if (e?.name === "AbortError") return new ProviderError("timeout", message, true);

  return new ProviderError(`${name}_error`, message, false);
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
