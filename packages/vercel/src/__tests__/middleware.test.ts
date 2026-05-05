import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loretMiddleware, mergeLoopGuards } from "../middleware.js";
import type {
  LanguageModelV3Middleware,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
} from "@ai-sdk/provider";

function toolCallMsg(toolCallId: string, toolName: string, input: unknown): LanguageModelV3Message {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  };
}

function toolResultMsg(toolCallId: string, toolName: string, value: string): LanguageModelV3Message {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId,
      toolName,
      output: { type: "text" as const, value },
    }],
  };
}

function makeParams(messages: LanguageModelV3Message[]): LanguageModelV3CallOptions {
  return { prompt: messages } as LanguageModelV3CallOptions;
}

function getLastToolResultText(prompt: LanguageModelV3Message[]): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i];
    if (msg.role === "tool") {
      const part = msg.content[0];
      if (part.type === "tool-result") {
        return String((part.output as any).value ?? "");
      }
    }
  }
  return "";
}

describe("loretMiddleware", () => {
  let mw: LanguageModelV3Middleware;

  beforeEach(() => {
    mw = loretMiddleware({
      traceId: "test-trace",
      loopGuards: { classAConsecutive: 3 },
    });
  });

  it("has specificationVersion v3", () => {
    assert.equal(mw.specificationVersion, "v3");
  });

  it("passes through when no loop detected", async () => {
    const params = makeParams([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    const result = await mw.transformParams!({ params });
    assert.deepEqual(result.prompt, params.prompt);
  });

  it("allows non-repeating tool calls", async () => {
    for (let i = 1; i <= 4; i++) {
      const messages: LanguageModelV3Message[] = [];
      for (let j = 1; j <= i; j++) {
        messages.push(toolCallMsg(`call-${j}`, "search", { q: `query-${j}` }));
        messages.push(toolResultMsg(`call-${j}`, "search", `result-${j}`));
      }

      const result = await mw.transformParams!({ params: makeParams(messages) });
      assert.equal(result.prompt.length, messages.length);
    }
  });

  it("replaces last tool result with recovery after consecutive identical calls", async () => {
    const messages: LanguageModelV3Message[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`call-${i}`, "check_status", { id: "deploy-1" }));
      messages.push(toolResultMsg(`call-${i}`, "check_status", '{"status":"deploying"}'));
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("call-4", "check_status", { id: "deploy-1" }));
    messages.push(toolResultMsg("call-4", "check_status", '{"status":"deploying"}'));

    const result = await mw.transformParams!({ params: makeParams(messages) });

    // Same number of messages — last tool result replaced, not appended
    assert.equal(result.prompt.length, messages.length);

    const recoveryText = getLastToolResultText(result.prompt);
    assert.ok(recoveryText.includes("[LOOP DETECTED]"));
    assert.ok(recoveryText.includes("check_status"));
    assert.ok(recoveryText.includes("STOP IMMEDIATELY"));
  });

  it("calls onBlocked callback when loop detected", async () => {
    let blockedReason = "";
    mw = loretMiddleware({
      traceId: "test-cb",
      loopGuards: { classAConsecutive: 3 },
      onBlocked: (reason) => { blockedReason = reason; },
    });

    const messages: LanguageModelV3Message[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`c-${i}`, "deploy", { v: "1.0" }));
      messages.push(toolResultMsg(`c-${i}`, "deploy", "started"));
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("c-4", "deploy", { v: "1.0" }));
    messages.push(toolResultMsg("c-4", "deploy", "started"));

    await mw.transformParams!({ params: makeParams(messages) });

    assert.ok(blockedReason.includes("loop detected"));
  });

  it("handles error-type tool results", async () => {
    mw = loretMiddleware({
      traceId: "test-error",
      loopGuards: { classAConsecutive: 3 },
    });

    const messages: LanguageModelV3Message[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`e-${i}`, "api_call", { url: "/health" }));
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: `e-${i}`,
          toolName: "api_call",
          output: { type: "error-text" as const, value: "timeout" },
        }],
      });
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("e-4", "api_call", { url: "/health" }));
    messages.push({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "e-4",
        toolName: "api_call",
        output: { type: "error-text" as const, value: "timeout" },
      }],
    });

    const result = await mw.transformParams!({ params: makeParams(messages) });

    const recoveryText = getLastToolResultText(result.prompt);
    assert.ok(recoveryText.includes("[LOOP DETECTED]"));
    assert.ok(recoveryText.includes("FAILING repeatedly"));
  });

  it("handles JSON tool results", async () => {
    mw = loretMiddleware({
      traceId: "test-json",
      loopGuards: { classAConsecutive: 3 },
    });

    const messages: LanguageModelV3Message[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`j-${i}`, "get_data", {}));
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: `j-${i}`,
          toolName: "get_data",
          output: { type: "json" as const, value: { status: "pending" } },
        }],
      });
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("j-4", "get_data", {}));
    messages.push({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "j-4",
        toolName: "get_data",
        output: { type: "json" as const, value: { status: "pending" } },
      }],
    });

    const result = await mw.transformParams!({ params: makeParams(messages) });

    const recoveryText = getLastToolResultText(result.prompt);
    assert.ok(recoveryText.includes("[LOOP DETECTED]"));
  });

  it("generates trace ID when not provided", async () => {
    const m = loretMiddleware();
    assert.equal(m.specificationVersion, "v3");

    const result = await m.transformParams!({
      params: makeParams([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    });

    assert.equal(result.prompt.length, 1);
  });

  it("supports async onBlocked for external logging", async () => {
    const log: string[] = [];
    mw = loretMiddleware({
      traceId: "test-async",
      loopGuards: { classAConsecutive: 3 },
      onBlocked: async (reason) => {
        await new Promise((r) => setTimeout(r, 10));
        log.push(reason);
      },
    });

    const messages: LanguageModelV3Message[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`a-${i}`, "poll", { id: "x" }));
      messages.push(toolResultMsg(`a-${i}`, "poll", "pending"));
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("a-4", "poll", { id: "x" }));
    messages.push(toolResultMsg("a-4", "poll", "pending"));

    await mw.transformParams!({ params: makeParams(messages) });

    assert.equal(log.length, 1);
    assert.ok(log[0].includes("loop detected"));
  });

  it("recovery message includes tool name and required actions", async () => {
    mw = loretMiddleware({
      traceId: "test-detail",
      loopGuards: { classAConsecutive: 3 },
    });

    const messages: LanguageModelV3Message[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`d-${i}`, "check", { id: "y" }));
      messages.push(toolResultMsg(`d-${i}`, "check", "same"));
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("d-4", "check", { id: "y" }));
    messages.push(toolResultMsg("d-4", "check", "same"));

    const result = await mw.transformParams!({ params: makeParams(messages) });

    const recoveryText = getLastToolResultText(result.prompt);
    assert.ok(recoveryText.includes('"check"'));
    assert.ok(recoveryText.includes("consecutive times"));
    assert.ok(recoveryText.includes("Do NOT call"));
    assert.ok(recoveryText.includes("Required actions"));
  });

  it("exposes transformParams and wrapGenerate", () => {
    assert.ok(typeof mw.transformParams === "function");
    assert.ok(typeof mw.wrapGenerate === "function");
  });

  it("replaces tool result in place without changing prompt length", async () => {
    const messages: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "deploy it" }] },
    ];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`p-${i}`, "status", { id: "x" }));
      messages.push(toolResultMsg(`p-${i}`, "status", "pending"));
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("p-4", "status", { id: "x" }));
    messages.push(toolResultMsg("p-4", "status", "pending"));

    const result = await mw.transformParams!({ params: makeParams(messages) });

    // Same length — tool result replaced, not appended
    assert.equal(result.prompt.length, messages.length);
    // Original user message preserved
    assert.equal(result.prompt[0].role, "user");
    assert.equal((result.prompt[0].content as any[])[0].text, "deploy it");
  });

  it("includes original task in recovery message", async () => {
    mw = loretMiddleware({
      traceId: "test-task",
      loopGuards: { classAConsecutive: 3 },
    });

    const messages: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "Deploy payments-api v2.4.1" }] },
    ];
    for (let i = 1; i <= 3; i++) {
      messages.push(toolCallMsg(`t-${i}`, "check", { id: "x" }));
      messages.push(toolResultMsg(`t-${i}`, "check", "deploying"));
    }

    await mw.transformParams!({ params: makeParams(messages) });

    messages.push(toolCallMsg("t-4", "check", { id: "x" }));
    messages.push(toolResultMsg("t-4", "check", "deploying"));

    const result = await mw.transformParams!({ params: makeParams(messages) });

    const recoveryText = getLastToolResultText(result.prompt);
    assert.ok(recoveryText.includes("Deploy payments-api v2.4.1"));
  });
});

describe("mergeLoopGuards", () => {
  it("returns defaults when no overrides", () => {
    const result = mergeLoopGuards({ classAConsecutive: 3, windowSize: 5 });
    assert.deepEqual(result, { classAConsecutive: 3, windowSize: 5 });
  });

  it("overrides specific fields", () => {
    const result = mergeLoopGuards(
      { classAConsecutive: 3, windowSize: 5 },
      { classAConsecutive: 5 },
    );
    assert.equal(result.classAConsecutive, 5);
    assert.equal(result.windowSize, 5);
  });

  it("overrides all fields", () => {
    const result = mergeLoopGuards(
      { classAConsecutive: 3, windowSize: 5 },
      { classAConsecutive: 10, windowSize: 20 },
    );
    assert.equal(result.classAConsecutive, 10);
    assert.equal(result.windowSize, 20);
  });
});
