import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loret } from "../session.js";

describe("loret() session", () => {
  it("passes through results when no loop detected", async () => {
    const session = loret();
    const fn = async (x: string) => `result-${x}`;
    const safe = session.guard("myTool", fn);

    const result = await safe("a");
    assert.equal(result, "result-a");

    const result2 = await safe("b");
    assert.equal(result2, "result-b");

    session.reset();
  });

  it("returns recovery message after Class A loop", async () => {
    const session = loret({ classAConsecutive: 3 });
    const fn = async () => "same-result";
    const safe = session.guard("stuckTool", fn);

    // classAConsecutive=3 needs 4 calls: 1 baseline + 3 consecutive matches
    assert.equal(await safe(), "same-result");
    assert.equal(await safe(), "same-result");
    assert.equal(await safe(), "same-result");
    const fourth = await safe();
    assert.ok(typeof fourth === "string");
    assert.ok((fourth as string).includes("[LOOP DETECTED]"));
    assert.ok((fourth as string).includes("stuckTool"));

    session.reset();
  });

  it("infers function name from fn.name", async () => {
    const session = loret({ classAConsecutive: 2 });
    async function fetchOrders() { return "same"; }
    const safe = session.guard(fetchOrders);

    // classAConsecutive=2 needs 3 calls: 1 baseline + 2 consecutive
    await safe();
    await safe();
    const third = await safe();
    assert.ok(typeof third === "string");
    assert.ok((third as string).includes("fetchOrders"));

    session.reset();
  });

  it("calls onBlocked when loop detected", async () => {
    let blocked: { tool: string; reason: string } | null = null;
    const session = loret({
      classAConsecutive: 2,
      onBlocked: (tool, reason) => { blocked = { tool, reason }; },
    });
    const safe = session.guard("myTool", async () => "same");

    await safe();
    await safe();
    assert.equal(blocked, null);

    await safe();
    assert.ok(blocked !== null);
    assert.equal(blocked!.tool, "myTool");
  });

  it("throws on hard stop after recovery is ignored", async () => {
    let hardStopped = false;
    const session = loret({
      classAConsecutive: 2,
      onHardStop: () => { hardStopped = true; },
    });
    const safe = session.guard("myTool", async () => "same");

    await safe();
    await safe();
    const recovery = await safe();
    assert.ok((recovery as string).includes("[LOOP DETECTED]"));

    await assert.rejects(() => safe(), /\[LORET\]/);
    assert.ok(hardStopped);
  });

  it("handles errors from the wrapped function", async () => {
    const session = loret({ classAConsecutive: 3 });
    const fn = async () => { throw new Error("timeout"); };
    const safe = session.guard("failTool", fn);

    // 4 calls needed: 1 baseline + 3 consecutive (all same error)
    await assert.rejects(() => safe(), /timeout/);
    await assert.rejects(() => safe(), /timeout/);
    await assert.rejects(() => safe(), /timeout/);
    const fourth = await safe();
    assert.ok(typeof fourth === "string");
    assert.ok((fourth as string).includes("[LOOP DETECTED]"));
  });

  it("resets state so the session can be reused", async () => {
    const session = loret({ classAConsecutive: 2 });
    const safe = session.guard("myTool", async () => "same");

    await safe();
    await safe();
    await safe(); // triggers recovery

    session.reset();

    const result = await safe();
    assert.equal(result, "same");
  });

  it("detects Class B loop (repeated failures with different args)", async () => {
    const session = loret({
      classAConsecutive: 10,
      classBSuspicion: 4,
      classBToolWindow: 6,
      classBDistinctArgs: 2,
    });
    const fn = async (id: string) => { throw new Error(`not found: ${id}`); };
    const safe = session.guard("search", fn);

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => safe(`id-${i}`));
    }

    const fourth = await safe("id-3");
    assert.ok(typeof fourth === "string");
    assert.ok((fourth as string).includes("[LOOP DETECTED]"));
    assert.ok((fourth as string).includes("search"));
  });
});
