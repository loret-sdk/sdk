/**
 * Loret SDK — Phase 1 Local Validation
 *
 * Human-readable output for manual inspection.
 * For automated assertions see src/__tests__/sdk.test.ts.
 *
 * Scenarios:
 *   1. Successful request path
 *   2. Budget-blocked request (enforce mode)
 *   3. Provider failure with retry → fallback
 */

import {
  AllProvidersFailedError,
  BudgetExceededError,
  PiiBlockedError,
  TraceGuardExceededError,
  WorkflowGuardExceededError,
} from "../src/index.js";
import {
  MockProvider,
  NoopTelemetryTransport,
  ConsoleTelemetryTransport,
  buildBootstrapSnapshot,
  createTestClient,
} from "../src/testing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function pass(msg: string) {
  console.log(`  ✓  ${msg}`);
}
function fail(msg: string) {
  console.log(`  ✗  ${msg}`);
}
function info(msg: string) {
  console.log(`  ·  ${msg}`);
}

const MESSAGES = [{ role: "user" as const, content: "Say hello." }];

// ---------------------------------------------------------------------------
// Scenario 1 — Successful request path
// ---------------------------------------------------------------------------

async function scenario1() {
  section("Scenario 1: Successful request path");

  const provider = new MockProvider({
    name: "openai",
    response: "Hello from the mock provider!",
    inputTokens: 8,
    outputTokens: 12,
    latencyMs: 50,
  });

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
    }),
    transport: new ConsoleTelemetryTransport(),
  });

  try {
    const result = await client.run({ messages: MESSAGES });

    pass(`content:       "${result.content}"`);
    pass(`provider:      ${result.provider}`);
    pass(`model:         ${result.model}`);
    pass(`inputTokens:   ${result.usage.inputTokens}`);
    pass(`outputTokens:  ${result.usage.outputTokens}`);
    pass(`estimatedCost: $${result.usage.estimatedCostUsd.toFixed(6)}`);
    pass(`latencyMs:     ${result.latencyMs}`);
    pass(`usedFallback:  ${result.usedFallback}`);
    pass(`totalAttempts: ${result.totalAttempts}`);
    pass(`adapter calls: ${provider.getCallCount()}`);

    if (result.content !== "Hello from the mock provider!") fail("unexpected content");
    if (result.usedFallback) fail("should not have used fallback");
    if (provider.getCallCount() !== 1) fail("expected exactly 1 adapter call");
  } finally {
    await client.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — Budget-blocked request (enforce mode, per_call limit)
// ---------------------------------------------------------------------------

async function scenario2() {
  section("Scenario 2: Budget-blocked request (enforce mode)");

  const provider = new MockProvider({
    name: "openai",
    response: "This should never be returned.",
    outputTokens: 100,
  });

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      mode: "enforce",
      budgetLimits: [{ scope: "per_call", maxOutputTokens: 50 }],
    }),
    transport: new ConsoleTelemetryTransport(),
  });

  try {
    await client.run({ messages: MESSAGES, maxTokens: 100 });
    fail("expected BudgetExceededError but run() succeeded");
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      pass(`BudgetExceededError thrown as expected`);
      pass(`code:  ${err.code}`);
      pass(`scope: ${err.scope}`);
      info(`reason: ${err.reason}`);
      if (provider.getCallCount() > 0) {
        fail("adapter should not have been called when budget is blocked");
      } else {
        pass("adapter was never called (blocked before dispatch)");
      }
    } else {
      fail(`unexpected error: ${err}`);
    }
  } finally {
    await client.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — Provider failure: retry on primary → fallback to secondary
// ---------------------------------------------------------------------------

async function scenario3() {
  section("Scenario 3: Retry + fallback");

  const primary = new MockProvider({
    name: "openai",
    alwaysFail: true,
    errorCode: "rate_limited",
    retryable: true,
  });

  const fallback = new MockProvider({
    name: "anthropic",
    response: "Fallback provider response.",
    inputTokens: 9,
    outputTokens: 15,
  });

  const client = createTestClient({
    adapters: [primary, fallback],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [
        { provider: "openai", model: "gpt-4o", priority: 0 },
        { provider: "anthropic", model: "claude-sonnet-4-6", priority: 1 },
      ],
      maxRetries: 1,
    }),
    transport: new ConsoleTelemetryTransport(),
  });

  try {
    const result = await client.run({ messages: MESSAGES });

    pass(`content:       "${result.content}"`);
    pass(`provider:      ${result.provider}  (fallback)`);
    pass(`model:         ${result.model}`);
    pass(`usedFallback:  ${result.usedFallback}`);
    pass(`totalAttempts: ${result.totalAttempts}`);
    info(`primary calls:  ${primary.getCallCount()}  (expected 2: 1 attempt + 1 retry)`);
    info(`fallback calls: ${fallback.getCallCount()}  (expected 1)`);

    if (!result.usedFallback) fail("expected usedFallback=true");
    if (result.provider !== "anthropic") fail("expected anthropic as final provider");
    if (primary.getCallCount() !== 2)
      fail(`expected 2 primary calls, got ${primary.getCallCount()}`);
    if (fallback.getCallCount() !== 1)
      fail(`expected 1 fallback call, got ${fallback.getCallCount()}`);
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      fail("AllProvidersFailedError — all providers exhausted");
      for (const attempt of err.attempts) {
        info(
          `  attempt ${attempt.attemptNumber}: ${attempt.provider}/${attempt.model} → ${attempt.errorCode}`,
        );
      }
    } else {
      fail(`unexpected error: ${err}`);
    }
  } finally {
    await client.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — Budget: monitor mode (request proceeds despite limit)
// ---------------------------------------------------------------------------

async function scenario4() {
  section("Scenario 4: Budget monitor mode (request proceeds)");

  const provider = new MockProvider({
    name: "openai",
    response: "Allowed through in monitor mode.",
    outputTokens: 100,
  });
  const transport = new NoopTelemetryTransport();

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      mode: "monitor",
      budgetLimits: [{ scope: "per_call", maxOutputTokens: 50 }],
    }),
    transport,
  });

  try {
    const result = await client.run({ messages: MESSAGES, maxTokens: 100 });
    await client.shutdown();

    if (result.content === "Allowed through in monitor mode.") {
      pass("request succeeded despite budget limit (monitor mode)");
    } else {
      fail("unexpected content");
    }

    const events = transport.sent.flatMap((b) => b.events).map((e) => e.eventType);

    if (events.includes("budget_blocked")) {
      pass("budget_blocked event emitted");
    } else {
      fail("budget_blocked event missing — monitor mode should still emit it");
    }
    if (events.includes("request_completed")) {
      pass("request_completed emitted (request was not hard-blocked)");
    } else {
      fail("request_completed missing");
    }
    if (provider.getCallCount() === 1) {
      pass("adapter was called (monitor mode does not prevent dispatch)");
    } else {
      fail(`expected 1 adapter call, got ${provider.getCallCount()}`);
    }
  } catch (err) {
    fail(`unexpected error in monitor mode: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5 — Pricing: configured pricing vs fallback (getDebugState)
// ---------------------------------------------------------------------------

async function scenario5() {
  section("Scenario 5: Pricing-driven cost estimate and getDebugState");

  // Part A — pricing configured: usingFallbackPricing should be false
  const clientA = createTestClient({
    adapters: [new MockProvider({ name: "openai" })],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          priority: 1,
          inputUsdPer1kTokens: 0.00015,
          outputUsdPer1kTokens: 0.0006,
        },
      ],
    }),
  });

  await clientA.run({ messages: MESSAGES, maxTokens: 100 });
  const stateA = clientA.getDebugState();
  await clientA.shutdown();

  if (stateA.usingFallbackPricing === false) {
    pass("usingFallbackPricing=false when pricing is configured");
  } else {
    fail(`expected false, got ${stateA.usingFallbackPricing}`);
  }

  // Part B — no pricing configured: usingFallbackPricing should be true
  const clientB = createTestClient({
    adapters: [new MockProvider({ name: "openai" })],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
    }),
  });

  await clientB.run({ messages: MESSAGES, maxTokens: 100 });
  const stateB = clientB.getDebugState();
  await clientB.shutdown();

  if (stateB.usingFallbackPricing === true) {
    pass("usingFallbackPricing=true when no pricing is configured");
  } else {
    fail(`expected true, got ${stateB.usingFallbackPricing}`);
  }

  // Part C — verify getDebugState() is undefined before first run()
  const clientC = createTestClient({
    adapters: [new MockProvider({ name: "openai" })],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
    }),
  });
  const stateC = clientC.getDebugState();
  await clientC.shutdown();

  if (stateC.usingFallbackPricing === undefined) {
    pass("usingFallbackPricing=undefined before first run()");
  } else {
    fail(`expected undefined before first run(), got ${stateC.usingFallbackPricing}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 6 — Privacy: block mode
// ---------------------------------------------------------------------------

async function scenario6() {
  section("Scenario 6: Privacy block mode");

  const provider = new MockProvider({ name: "openai", response: "Should not be returned." });

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      privacy: { mode: "block" },
    }),
  });

  const piiMessages = [{ role: "user" as const, content: "My email is user@example.com" }];

  try {
    await client.run({ messages: piiMessages });
    await client.shutdown();
    fail("expected PiiBlockedError but run() succeeded");
  } catch (err) {
    await client.shutdown();
    if (err instanceof PiiBlockedError) {
      pass("PiiBlockedError thrown as expected");
      pass(`code: ${err.code}`);
      info(`categories: ${err.detectedCategories.join(", ")}`);
      if (provider.getCallCount() === 0) {
        pass("adapter was never called (PII blocked before dispatch)");
      } else {
        fail(`adapter should not have been called, got ${provider.getCallCount()} calls`);
      }
    } else {
      fail(`unexpected error: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 7 — Privacy: redact mode
// ---------------------------------------------------------------------------

async function scenario7() {
  section("Scenario 7: Privacy redact mode");

  const provider = new MockProvider({ name: "openai", response: "Received redacted content." });

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      privacy: { mode: "redact" },
    }),
  });

  const originalContent = "My email is user@example.com and card 1234-5678-9012-3456";
  const piiMessages = [{ role: "user" as const, content: originalContent }];

  try {
    const result = await client.run({ messages: piiMessages });
    await client.shutdown();

    pass(`request succeeded: "${result.content}"`);

    const dispatchedMessages = provider.getLastInput()?.messages;
    if (!dispatchedMessages) {
      fail("could not retrieve dispatched messages from adapter");
      return;
    }

    const dispatchedContent = dispatchedMessages[0].content;
    if (dispatchedContent.includes("user@example.com")) {
      fail("email was NOT redacted before dispatch — original content reached the provider");
    } else if (dispatchedContent.includes("[REDACTED_EMAIL]")) {
      pass("email redacted in dispatched content");
    } else {
      fail(`unexpected dispatched content: "${dispatchedContent}"`);
    }

    if (dispatchedContent.includes("1234-5678-9012-3456")) {
      fail("credit card was NOT redacted before dispatch");
    } else if (dispatchedContent.includes("[REDACTED_CARD]")) {
      pass("credit card redacted in dispatched content");
    } else {
      fail(`unexpected card redaction in: "${dispatchedContent}"`);
    }
  } catch (err) {
    await client.shutdown();
    fail(`unexpected error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 8 — Privacy: monitor mode (detect and emit, do not block)
// ---------------------------------------------------------------------------

async function scenario8() {
  section("Scenario 8: Privacy monitor mode");

  const provider = new MockProvider({
    name: "openai",
    response: "Request allowed through with original content.",
  });
  const transport = new NoopTelemetryTransport();

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      privacy: { mode: "monitor" },
    }),
    transport,
  });

  const piiMessages = [{ role: "user" as const, content: "My SSN is 123-45-6789" }];

  try {
    const result = await client.run({ messages: piiMessages });
    await client.shutdown();

    pass(`request succeeded: "${result.content}"`);

    const dispatchedContent = provider.getLastInput()?.messages[0].content;
    if (dispatchedContent === piiMessages[0].content) {
      pass("original (unredacted) content dispatched to provider");
    } else {
      fail(`monitor mode should not modify content; got: "${dispatchedContent}"`);
    }

    const events = transport.sent.flatMap((b) => b.events).map((e) => e.eventType);
    if (events.includes("privacy_detected")) {
      pass("privacy_detected event emitted");
    } else {
      fail("privacy_detected event missing — monitor mode should emit it");
    }
    if (events.includes("request_completed")) {
      pass("request_completed emitted (not blocked)");
    } else {
      fail("request_completed missing");
    }
  } catch (err) {
    await client.shutdown();
    fail(`unexpected error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 9 — Trace guard: enforce mode blocks before dispatch
// ---------------------------------------------------------------------------

async function scenario9() {
  section("Scenario 9: Trace guard — enforce mode");

  const provider = new MockProvider({ name: "openai" });

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      mode: "enforce",
      // maxCallsPerTrace=0: block any dispatch attempt
      traceGuards: { maxCallsPerTrace: 0 },
    }),
  });

  try {
    await client.run({ messages: MESSAGES });
    await client.shutdown();
    fail("expected TraceGuardExceededError but run() succeeded");
  } catch (err) {
    await client.shutdown();
    if (err instanceof TraceGuardExceededError) {
      pass("TraceGuardExceededError thrown as expected");
      pass(`code:      ${err.code}`);
      pass(`dimension: ${err.dimension}`);
      info(`reason:    ${err.message}`);
      if (provider.getCallCount() === 0) {
        pass("adapter was never called (trace guard blocked before dispatch)");
      } else {
        fail(`adapter should not have been called, got ${provider.getCallCount()} calls`);
      }
    } else {
      fail(`unexpected error: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 10 — Workflow guard: enforce mode blocks second run() in workflow
// ---------------------------------------------------------------------------

async function scenario10() {
  section("Scenario 10: Workflow guard — enforce mode");

  const provider = new MockProvider({ name: "openai", response: "First run ok." });

  const client = createTestClient({
    adapters: [provider],
    snapshot: buildBootstrapSnapshot({
      projectId: "proj_validate",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      mode: "enforce",
      workflowGuards: { maxCallsPerWorkflow: 1 },
    }),
  });

  const workflowId = "wf-validate-001";

  try {
    // First call — within limit
    const result1 = await client.run({ messages: MESSAGES, metadata: { traceId: workflowId } });
    pass(`first run() succeeded: "${result1.content}"`);

    // Second call — should be blocked
    try {
      await client.run({ messages: MESSAGES, metadata: { traceId: workflowId } });
      fail("expected WorkflowGuardExceededError on second run() but it succeeded");
    } catch (err) {
      if (err instanceof WorkflowGuardExceededError) {
        pass("WorkflowGuardExceededError thrown on second run() as expected");
        pass(`code:      ${err.code}`);
        pass(`dimension: ${err.dimension}`);
        info(`reason:    ${err.message}`);
      } else {
        fail(`unexpected error on second run(): ${err}`);
      }
    }
  } catch (err) {
    fail(`unexpected error on first run(): ${err}`);
  } finally {
    await client.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nLoret SDK — Phase 1 Local Validation");
  console.log(`Node ${process.version}  |  ${new Date().toISOString()}`);

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();
  await scenario9();
  await scenario10();

  console.log(`\n${"─".repeat(60)}`);
  console.log("  Done.");
  console.log("─".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("Validation runner failed unexpectedly:", err);
  process.exit(1);
});
