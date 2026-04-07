/**
 * Loret SDK — local simulator
 *
 * Runs mixed synthetic traffic through the SDK using MockProvider.
 * No real API calls are made. Output is written to:
 *   apps/dashboard/public/data/summary.json
 *
 * Run: pnpm simulate
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createTestClient, buildBootstrapSnapshot, MockProvider } from "../src/testing.js";
import { BudgetExceededError, TraceGuardExceededError, AllProvidersFailedError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SimResult {
  scenario: string;
  status: "success" | "budget_blocked" | "trace_guard_blocked" | "all_failed" | "error";
  provider: string | null;
  usedFallback: boolean;
  costUsd: number;
  avoidedCostUsd: number;
  latencyMs: number;
  errorCode: string | null;
}

interface SimSummary {
  totalRequests: number;
  successful: number;
  blockedByBudget: number;
  blockedByTraceGuard: number;
  fallbacks: number;
  failed: number;
  estimatedSpendUsd: number;
  estimatedAvoidedUsd: number;
  avgLatencyMs: number;
}

// Matches the nominal rate used by the SDK's trace guard estimator.
// Used here only to estimate avoided cost on blocked requests.
const NOMINAL_RATE_PER_OUTPUT_TOKEN = 0.000015;

const MESSAGES = [{ role: "user" as const, content: "Simulate this request." }];

// ---------------------------------------------------------------------------
// Runner — wraps a single client.run() call and normalises the result
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: string,
  client: ReturnType<typeof createTestClient>,
  runOptions: { messages: typeof MESSAGES; maxTokens?: number },
): Promise<SimResult> {
  const startedAt = Date.now();

  try {
    const result = await client.run(runOptions);
    await client.shutdown();

    return {
      scenario,
      status: "success",
      provider: result.provider,
      usedFallback: result.usedFallback,
      costUsd: result.usage.estimatedCostUsd,
      avoidedCostUsd: 0,
      latencyMs: result.latencyMs,
      errorCode: null,
    };
  } catch (err) {
    await client.shutdown();
    const latencyMs = Date.now() - startedAt;
    const avoidedEstimate = (runOptions.maxTokens ?? 200) * NOMINAL_RATE_PER_OUTPUT_TOKEN;

    if (err instanceof BudgetExceededError) {
      return { scenario, status: "budget_blocked", provider: null, usedFallback: false, costUsd: 0, avoidedCostUsd: avoidedEstimate, latencyMs, errorCode: "BUDGET_EXCEEDED" };
    }

    if (err instanceof TraceGuardExceededError) {
      return { scenario, status: "trace_guard_blocked", provider: null, usedFallback: false, costUsd: 0, avoidedCostUsd: avoidedEstimate, latencyMs, errorCode: `TRACE_GUARD_EXCEEDED (${err.dimension})` };
    }

    if (err instanceof AllProvidersFailedError) {
      return { scenario, status: "all_failed", provider: null, usedFallback: false, costUsd: 0, avoidedCostUsd: 0, latencyMs, errorCode: "ALL_PROVIDERS_FAILED" };
    }

    return { scenario, status: "error", provider: null, usedFallback: false, costUsd: 0, avoidedCostUsd: 0, latencyMs, errorCode: err instanceof Error ? err.message : "UNKNOWN" };
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(results: SimResult[]): SimSummary {
  const totalLatency = results.reduce((s, r) => s + r.latencyMs, 0);

  return {
    totalRequests: results.length,
    successful: results.filter((r) => r.status === "success").length,
    blockedByBudget: results.filter((r) => r.status === "budget_blocked").length,
    blockedByTraceGuard: results.filter((r) => r.status === "trace_guard_blocked").length,
    fallbacks: results.filter((r) => r.usedFallback).length,
    failed: results.filter((r) => r.status === "all_failed" || r.status === "error").length,
    estimatedSpendUsd: round6(results.reduce((s, r) => s + r.costUsd, 0)),
    estimatedAvoidedUsd: round6(results.reduce((s, r) => s + r.avoidedCostUsd, 0)),
    avgLatencyMs: results.length > 0 ? Math.round((totalLatency / results.length) * 10) / 10 : 0,
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

async function runNormalRequests(results: SimResult[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    process.stdout.write(`  [${results.length + 1}] normal_request … `);
    const client = createTestClient({
      adapters: [new MockProvider({ name: "openai", response: "The answer is 42.", inputTokens: 50, outputTokens: 100 })],
      snapshot: buildBootstrapSnapshot({ projectId: "sim", providers: [{ provider: "openai", model: "gpt-4o" }] }),
    });
    const r = await runScenario("normal_request", client, { messages: MESSAGES, maxTokens: 100 });
    results.push(r);
    console.log(r.status);
  }
}

async function runBudgetBlocked(results: SimResult[]): Promise<void> {
  for (let i = 0; i < 2; i++) {
    process.stdout.write(`  [${results.length + 1}] budget_blocked … `);
    const client = createTestClient({
      adapters: [new MockProvider({ name: "openai" })],
      snapshot: buildBootstrapSnapshot({
        projectId: "sim",
        providers: [{ provider: "openai", model: "gpt-4o" }],
        mode: "enforce",
        budgetLimits: [{ scope: "per_call", maxOutputTokens: 50 }],
      }),
    });
    const r = await runScenario("budget_blocked", client, { messages: MESSAGES, maxTokens: 200 });
    results.push(r);
    console.log(r.status);
  }
}

async function runFallback(results: SimResult[]): Promise<void> {
  for (let i = 0; i < 2; i++) {
    process.stdout.write(`  [${results.length + 1}] fallback_triggered … `);
    const client = createTestClient({
      adapters: [
        new MockProvider({ name: "openai", alwaysFail: true }),
        new MockProvider({ name: "anthropic", response: "Fallback response.", inputTokens: 40, outputTokens: 80 }),
      ],
      snapshot: buildBootstrapSnapshot({
        projectId: "sim",
        providers: [
          { provider: "openai", model: "gpt-4o", priority: 0 },
          { provider: "anthropic", model: "claude-sonnet-4-6", priority: 1 },
        ],
        maxRetries: 0,
      }),
    });
    const r = await runScenario("fallback_triggered", client, { messages: MESSAGES, maxTokens: 80 });
    results.push(r);
    console.log(r.status);
  }
}

async function runTraceGuardCalls(results: SimResult[]): Promise<void> {
  // Primary always fails; guard blocks the 3rd attempt (limit=2). enforce mode required to throw.
  process.stdout.write(`  [${results.length + 1}] trace_guard_calls … `);
  const client = createTestClient({
    adapters: [new MockProvider({ name: "openai", alwaysFail: true, retryable: true })],
    snapshot: buildBootstrapSnapshot({
      projectId: "sim",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      mode: "enforce",
      maxRetries: 3,
      traceGuards: { maxCallsPerTrace: 2 },
    }),
  });
  const r = await runScenario("trace_guard_calls", client, { messages: MESSAGES, maxTokens: 150 });
  results.push(r);
  console.log(r.status);
}

async function runTraceGuardCost(results: SimResult[]): Promise<void> {
  // estimated cost = (500/1000)*0.015 = 0.0075 > limit 0.005 → blocked. enforce mode required to throw.
  process.stdout.write(`  [${results.length + 1}] trace_guard_cost … `);
  const client = createTestClient({
    adapters: [new MockProvider({ name: "openai" })],
    snapshot: buildBootstrapSnapshot({
      projectId: "sim",
      providers: [{ provider: "openai", model: "gpt-4o" }],
      mode: "enforce",
      traceGuards: { maxCostPerTraceUsd: 0.005 },
    }),
  });
  const r = await runScenario("trace_guard_cost", client, { messages: MESSAGES, maxTokens: 500 });
  results.push(r);
  console.log(r.status);
}

async function runAllFailed(results: SimResult[]): Promise<void> {
  process.stdout.write(`  [${results.length + 1}] all_providers_failed … `);
  const client = createTestClient({
    adapters: [
      new MockProvider({ name: "openai", alwaysFail: true, retryable: false }),
      new MockProvider({ name: "anthropic", alwaysFail: true, retryable: false }),
    ],
    snapshot: buildBootstrapSnapshot({
      projectId: "sim",
      providers: [
        { provider: "openai", model: "gpt-4o", priority: 0 },
        { provider: "anthropic", model: "claude-sonnet-4-6", priority: 1 },
      ],
      maxRetries: 0,
    }),
  });
  const r = await runScenario("all_providers_failed", client, { messages: MESSAGES, maxTokens: 100 });
  results.push(r);
  console.log(r.status);
}

async function runScenarios(): Promise<SimResult[]> {
  const results: SimResult[] = [];
  await runNormalRequests(results);
  await runBudgetBlocked(results);
  await runFallback(results);
  await runTraceGuardCalls(results);
  await runTraceGuardCost(results);
  await runAllFailed(results);
  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log("Loret SDK — local simulator\n");

  const results = await runScenarios();
  const summary = aggregate(results);
  const output = { generatedAt: new Date().toISOString(), summary, results };

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputPath = join(__dirname, "../../../apps/dashboard/public/data/summary.json");

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n✓ ${results.length} requests simulated`);
  console.log(`  Successful:    ${summary.successful}`);
  console.log(`  Budget blocks: ${summary.blockedByBudget}`);
  console.log(`  Guard blocks:  ${summary.blockedByTraceGuard}`);
  console.log(`  Fallbacks:     ${summary.fallbacks}`);
  console.log(`  Failed:        ${summary.failed}`);
  console.log(`  Spend:         $${summary.estimatedSpendUsd.toFixed(6)}`);
  console.log(`  Avoided:       $${summary.estimatedAvoidedUsd.toFixed(6)}`);
  console.log(`  Avg latency:   ${summary.avgLatencyMs}ms`);
  console.log(`\n  → ${outputPath}`);
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
