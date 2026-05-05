// ---------------------------------------------------------------------------
// LoopGuardStore — structural fingerprint loop detection.
//
// Class A: same toolName + args + result fingerprint on consecutive turns.
//          Blocks after classAConsecutive hits.
// Class B: per-tool sliding window of the last N calls to THAT tool.
//          Two trigger paths:
//            (a) failureCount >= threshold AND distinctArgs >= threshold
//            (b) failureCount >= threshold AND stable result fingerprint
//          A success for that tool clears its window (immediate cooldown).
// ---------------------------------------------------------------------------

import type { LoopGuards } from "../shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Tool metadata for loop detection.
 * Pass raw strings on each run(); the SDK fingerprints them internally with FNV1a32.
 */
export interface LoopSignal {
  /** Tool or action name. The primary stagnation key. */
  readonly toolName: string;
  /** Raw arguments string (JSON or plain text). SDK fingerprints internally. */
  readonly toolArgs?: string;
  /** Raw result string. SDK fingerprints internally. */
  readonly toolResult?: string;
  /** Outcome of the tool invocation for this turn. */
  readonly resultStatus: "success" | "empty" | "error";
}

/** The dimension that triggered a loop guard violation. */
export type LoopGuardDimension = "class_a" | "class_b" | "hard_stop";

export interface LoopGuardViolation {
  readonly allowed: false;
  readonly reason: string;
  readonly dimension: LoopGuardDimension;
  /** Number of consecutive Class A turns at violation time. */
  readonly consecutiveClassA: number;
  /** Class B failure count for this tool at violation time. */
  readonly suspicion: number;
}

export type LoopGuardCheckResult =
  | { readonly allowed: true; readonly consecutiveClassA: number; readonly suspicion: number }
  | LoopGuardViolation;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Fingerprinted record for one turn — used in both the global and per-tool windows. */
interface TurnRecord {
  readonly toolName: string;
  readonly argsFingerprint: string;
  readonly resultFingerprint: string;
  readonly resultStatus: "success" | "empty" | "error";
  readonly stagnationClass: "exact" | "exploration" | "none";
}

/** Per-tool Class B sliding window. */
interface ToolWindow {
  readonly calls: TurnRecord[];
}

/** Full per-traceId loop detection state. */
interface LoopState {
  /** Global sliding window — used only for Class A (prev-turn comparison). */
  readonly window: TurnRecord[];
  /** Per-tool sliding windows — used for Class B evaluation. */
  readonly toolWindows: Map<string, ToolWindow>;
  /** Current run of consecutive Class A turns. */
  consecutiveClassA: number;
  /** Informational suspicion (highest per-tool failure count). */
  suspicion: number;
  /** Tools that fired recovery — hard-stopped on repeat. */
  readonly blockedTools: Set<string>;
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CLASS_A_CONSECUTIVE    = 3;
const DEFAULT_WINDOW_SIZE            = 12;
const DEFAULT_CLASS_B_TOOL_WINDOW    = 6;
const DEFAULT_CLASS_B_THRESHOLD      = 4;
const DEFAULT_CLASS_B_DISTINCT_ARGS  = 2;
const DEFAULT_EVICTION_TTL_MS        = 60 * 60 * 1_000; // 1 hour

// ---------------------------------------------------------------------------
// LoopGuardStore
// ---------------------------------------------------------------------------

export class LoopGuardStore {
  private readonly states        = new Map<string, LoopState>();
  private readonly evictionTtlMs: number;

  constructor(evictionTtlMs: number = DEFAULT_EVICTION_TTL_MS) {
    this.evictionTtlMs = evictionTtlMs;
  }

  /**
   * Record this turn's signal and evaluate loop policy.
   * Synchronous, no I/O. State is always mutated — even on a block.
   */
  check(traceId: string, signal: LoopSignal, guards: LoopGuards): LoopGuardCheckResult {
    this.evictStale();

    const classAConsecutive  = guards.classAConsecutive   ?? DEFAULT_CLASS_A_CONSECUTIVE;
    const globalWindowSize   = guards.windowSize          ?? DEFAULT_WINDOW_SIZE;
    const classBToolWindow   = guards.classBToolWindow    ?? DEFAULT_CLASS_B_TOOL_WINDOW;
    const classBThreshold    = guards.classBSuspicion     ?? DEFAULT_CLASS_B_THRESHOLD;
    const classBDistinctArgs = guards.classBDistinctArgs  ?? DEFAULT_CLASS_B_DISTINCT_ARGS;

    const now = Date.now();

    let state = this.states.get(traceId);
    if (!state) {
      state = {
        window: [],
        toolWindows: new Map(),
        consecutiveClassA: 0,
        suspicion: 0,
        blockedTools: new Set(),
        lastUpdatedAt: now,
      };
      this.states.set(traceId, state);
    }
    state.lastUpdatedAt = now;

    // Hard stop: tool already fired recovery → immediate block.
    const argsKey     = signal.toolArgs != null ? fnv1a32hex(signal.toolArgs) : "";
    const blockKey    = signal.toolName + ":" + argsKey;
    const toolWideKey = signal.toolName + ":*";

    if (state.blockedTools.has(blockKey) || state.blockedTools.has(toolWideKey)) {
      return {
        allowed:           false,
        reason:            `Hard stop: tool="${signal.toolName}" was already recovered — agent must use a different tool or different approach`,
        dimension:         "hard_stop",
        consecutiveClassA: state.consecutiveClassA,
        suspicion:         state.suspicion,
      };
    }

    // Build fingerprinted record.
    const prev: TurnRecord | null =
      state.window.length > 0 ? (state.window[state.window.length - 1] ?? null) : null;

    const record: TurnRecord = {
      toolName:          signal.toolName,
      argsFingerprint:   signal.toolArgs   != null ? fnv1a32hex(signal.toolArgs)   : "",
      resultFingerprint: signal.toolResult != null ? fnv1a32hex(signal.toolResult) : "",
      resultStatus:      signal.resultStatus,
      stagnationClass:   classifyTurn(signal, prev),
    };

    // Append to global window (Class A prev-turn tracking).
    state.window.push(record);
    if (state.window.length > globalWindowSize) {
      state.window.shift();
    }

    // Append to per-tool window (Class B).
    let tw = state.toolWindows.get(signal.toolName);
    if (!tw) {
      tw = { calls: [] };
      state.toolWindows.set(signal.toolName, tw);
    }
    if (record.resultStatus === "success") {
      // Success clears this tool's failure history entirely.
      tw.calls.length = 0;
      tw.calls.push(record);
    } else {
      tw.calls.push(record);
      if (tw.calls.length > classBToolWindow) {
        tw.calls.shift();
      }
    }

    // -----------------------------------------------------------------------
    // Class A — exact stagnation
    // -----------------------------------------------------------------------

    if (record.stagnationClass === "exact") {
      state.consecutiveClassA++;
    } else {
      if (state.consecutiveClassA > 0) {
        state.suspicion = Math.floor(state.suspicion / 2);
      }
      state.consecutiveClassA = 0;
    }

    if (state.consecutiveClassA >= classAConsecutive) {
      state.blockedTools.add(blockKey);
      return {
        allowed:           false,
        reason:
          `${state.consecutiveClassA} consecutive identical tool calls detected ` +
          `(tool="${signal.toolName}", same args+result fingerprint) — ` +
          `classAConsecutive threshold: ${classAConsecutive}`,
        dimension:         "class_a",
        consecutiveClassA: state.consecutiveClassA,
        suspicion:         state.suspicion,
      };
    }

    // -----------------------------------------------------------------------
    // Class B — per-tool failure window
    // -----------------------------------------------------------------------

    const classB = evaluateClassB(tw.calls, classBThreshold, classBDistinctArgs);
    state.suspicion = classB.failureCount;

    if (classB.triggered) {
      state.blockedTools.add(toolWideKey);
      return {
        allowed:           false,
        reason:
          `${classB.failureCount} failed calls to tool="${signal.toolName}" ` +
          `in last ${classBToolWindow} calls to that tool ` +
          `(${classB.reason}) — ` +
          `classBSuspicion threshold: ${classBThreshold}`,
        dimension:         "class_b",
        consecutiveClassA: state.consecutiveClassA,
        suspicion:         state.suspicion,
      };
    }

    return {
      allowed:           true,
      consecutiveClassA: state.consecutiveClassA,
      suspicion:         state.suspicion,
    };
  }

  evictWorkflow(traceId: string): void {
    this.states.delete(traceId);
  }

  shutdown(): void {
    this.states.clear();
  }

  get size(): number {
    return this.states.size;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (now - state.lastUpdatedAt > this.evictionTtlMs) {
        this.states.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function classifyTurn(
  signal: LoopSignal,
  prev: TurnRecord | null,
): TurnRecord["stagnationClass"] {
  if (!prev) return "none";
  if (prev.toolName !== signal.toolName) return "none";

  const argsFingerprint   = signal.toolArgs   != null ? fnv1a32hex(signal.toolArgs)   : "";
  const resultFingerprint = signal.toolResult != null ? fnv1a32hex(signal.toolResult) : "";

  if (argsFingerprint === prev.argsFingerprint && resultFingerprint === prev.resultFingerprint) {
    return "exact";
  }

  const currentFailed = signal.resultStatus === "empty" || signal.resultStatus === "error";
  const prevFailed    = prev.resultStatus    === "empty" || prev.resultStatus    === "error";
  if (currentFailed && prevFailed) {
    return "exploration";
  }

  return "none";
}

/**
 * Evaluate Class B from a per-tool window.
 * Two trigger paths:
 *   (a) failures >= threshold AND distinct args >= distinctArgsThreshold
 *   (b) failures >= threshold AND all failures share the same result fingerprint
 *       (stable failure — agent varies args but gets identical error)
 */
function evaluateClassB(
  toolCalls: readonly TurnRecord[],
  failureThreshold: number,
  distinctArgsThreshold: number,
): {
  triggered: boolean;
  failureCount: number;
  reason: string;
} {
  const failures = toolCalls.filter(
    t => t.resultStatus === "empty" || t.resultStatus === "error",
  );

  const failureCount = failures.length;
  if (failureCount < failureThreshold) {
    return { triggered: false, failureCount, reason: "" };
  }

  const distinctArgs    = new Set(failures.map(t => t.argsFingerprint));
  const distinctResults = new Set(failures.map(t => t.resultFingerprint));

  // Path (a): enough failures with enough arg variation
  if (distinctArgs.size >= distinctArgsThreshold) {
    return {
      triggered: true,
      failureCount,
      reason: `${distinctArgs.size} distinct arg variations`,
    };
  }

  // Path (b): enough failures with stable result (same error every time, even same args)
  if (distinctResults.size === 1) {
    return {
      triggered: true,
      failureCount,
      reason: `stable failure fingerprint across ${failureCount} calls`,
    };
  }

  return { triggered: false, failureCount, reason: "" };
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit — inlined to avoid external dependencies.
// ---------------------------------------------------------------------------

function fnv1a32hex(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash  = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
