import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LoretCallbackHandler } from "../handler.js";

function serialized(name: string) {
  return { lc: 1, type: "not_implemented", id: ["langchain", "tools", name] } as any;
}

describe("LoretCallbackHandler", () => {
  let handler: LoretCallbackHandler;

  beforeEach(() => {
    handler = new LoretCallbackHandler({ loopGuards: { classAConsecutive: 3 } });
  });

  it("allows non-repeating tool calls", async () => {
    await handler.handleChainStart(serialized("chain"), {}, "chain-1");

    for (let i = 0; i < 3; i++) {
      const runId = `tool-${i}`;
      await handler.handleToolStart(serialized("search"), `query-${i}`, runId);
      await handler.handleToolEnd(`result-${i}`, runId);
    }

    assert.equal(handler.blocked, false);
  });

  it("blocks after 3 consecutive identical tool calls", async () => {
    await handler.handleChainStart(serialized("chain"), {}, "chain-1");

    for (let i = 0; i < 3; i++) {
      const runId = `tool-${i}`;
      await handler.handleToolStart(serialized("search"), '{"q":"users"}', runId);
      await handler.handleToolEnd("[]", runId);
    }

    // 4th identical call — handleToolEnd sets blocked flag
    await handler.handleToolStart(serialized("search"), '{"q":"users"}', "tool-3");
    await handler.handleToolEnd("[]", "tool-3");
    assert.equal(handler.blocked, true);

    // handleToolStart no longer throws — enforcement is via wrapTools
    await handler.handleToolStart(serialized("search"), '{"q":"users"}', "tool-4");
    assert.equal(handler.blocked, true);
  });

  it("calls onBlocked when loop is detected", async () => {
    let blockedReason = "";
    handler = new LoretCallbackHandler({
      loopGuards: { classAConsecutive: 3 },
      onBlocked: (reason) => { blockedReason = reason; },
    });

    await handler.handleChainStart(serialized("chain"), {}, "chain-1");

    for (let i = 0; i < 3; i++) {
      const runId = `tool-${i}`;
      await handler.handleToolStart(serialized("search"), "same", runId);
      await handler.handleToolEnd("same", runId);
    }

    await handler.handleToolStart(serialized("search"), "same", "tool-3");
    await handler.handleToolEnd("same", "tool-3");

    assert.ok(blockedReason.includes("loop detected"));
    assert.equal(handler.blocked, true);
  });

  it("blocks when budget is exceeded", async () => {
    handler = new LoretCallbackHandler({ maxCostUsd: 0.001 });

    await handler.handleLLMEnd({
      generations: [],
      llmOutput: {
        tokenUsage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
      },
    });

    assert.equal(handler.blocked, true);

    // handleLLMStart no longer throws — enforcement is via wrapTools
    await handler.handleLLMStart(serialized("llm"), ["prompt"]);
    assert.equal(handler.blocked, true);
  });

  it("tracks cumulative cost", async () => {
    handler = new LoretCallbackHandler({ maxCostUsd: 1.0 });

    await handler.handleLLMEnd({
      generations: [],
      llmOutput: {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });

    assert.ok(handler.getTotalCostUsd() > 0);
    assert.equal(handler.blocked, false);
  });

  it("does not block tool errors that differ", async () => {
    await handler.handleChainStart(serialized("chain"), {}, "chain-1");

    for (let i = 0; i < 3; i++) {
      const runId = `tool-${i}`;
      await handler.handleToolStart(serialized("search"), `different-${i}`, runId);
      await handler.handleToolError(new Error("fail"), runId);
    }

    assert.equal(handler.blocked, false);
  });

  it("wrapTools returns recovery message instead of throwing", async () => {
    const fakeTool = { _call: async () => "original result" } as any;
    handler.wrapTools([fakeTool]);

    await handler.handleChainStart(serialized("chain"), {}, "chain-1");

    for (let i = 0; i < 3; i++) {
      const runId = `tool-${i}`;
      await handler.handleToolStart(serialized("search"), "same", runId);
      await handler.handleToolEnd("same", runId);
    }
    await handler.handleToolStart(serialized("search"), "same", "tool-3");
    await handler.handleToolEnd("same", "tool-3");
    assert.equal(handler.blocked, true);

    const result = await fakeTool._call();
    assert.ok(typeof result === "string");
    assert.ok(result.includes("[LOOP DETECTED]"));
    assert.ok(result.includes("Do NOT call"));
  });

  it("resets state cleanly", async () => {
    await handler.handleChainStart(serialized("chain"), {}, "chain-1");

    // Build up some loop state
    for (let i = 0; i < 3; i++) {
      const runId = `tool-${i}`;
      await handler.handleToolStart(serialized("search"), "same", runId);
      await handler.handleToolEnd("same", runId);
    }
    await handler.handleToolStart(serialized("search"), "same", "tool-3");
    await handler.handleToolEnd("same", "tool-3");
    assert.equal(handler.blocked, true);

    handler.reset();
    assert.equal(handler.blocked, false);

    // After reset, same pattern should not immediately block
    await handler.handleChainStart(serialized("chain"), {}, "chain-2");
    for (let i = 0; i < 2; i++) {
      const runId = `tool-after-reset-${i}`;
      await handler.handleToolStart(serialized("search"), "same", runId);
      await handler.handleToolEnd("same", runId);
    }
    assert.equal(handler.blocked, false);
  });
});
