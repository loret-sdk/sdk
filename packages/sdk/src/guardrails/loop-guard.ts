// ---------------------------------------------------------------------------
// LoopGuardStore — structural fingerprint loop detection.
//
// Class A: same toolName + args + result fingerprint on consecutive turns.
//          Blocks after classAConsecutive hits.
// Class B: same tool, varying args, repeated empty/error.
//          Suspicion accumulates but never blocks alone.
//          Suspicion is halved (not reset) when a Class A chain clears.
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
export type LoopGuardDimension = "class_a";

export interface LoopGuardViolation {
  readonly allowed: false;
  readonly reason: string;
  readonly dimension: LoopGuardDimension;
  /** Number of consecutive Class A turns at violation time. */
  readonly consecutiveClassA: number;
  /** Accumulated Class B suspicion at violation time. */
  readonly suspicion: number;
}

export type LoopGuardCheckResult =
  | { readonly allowed: true; readonly consecutiveClassA: number; readonly suspicion: number }
  | LoopGuardViolation;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Fingerprinted, classified record for one turn in the sliding window. */
interface TurnRecord {
  readonly toolName: string;
  readonly argsFingerprint: string;
  readonly resultFingerprint: string;
  readonly resultStatus: "success" | "empty" | "error";
  readonly stagnationClass: "exact" | "exploration" | "none";
}

/** Full per-traceId loop detection state. */
interface LoopState {
  /** Sliding window of recent TurnRecords, oldest at index 0, capped at windowSize. */
  readonly window: TurnRecord[];
  /** Current run of consecutive Class A turns. Resets to 0 when the chain breaks. */
  consecutiveClassA: number;
  /**
   * Accumulated Class B suspicion score.
   * Halved (floor) — not reset — when a Class A chain clears.
   */
  suspicion: number;
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CLASS_A_CONSECUTIVE = 3;
const DEFAULT_WINDOW_SIZE         = 5;
const DEFAULT_EVICTION_TTL_MS     = 60 * 60 * 1_000; // 1 hour

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

    const classAConsecutive = guards.classAConsecutive ?? DEFAULT_CLASS_A_CONSECUTIVE;
    const windowSize        = guards.windowSize        ?? DEFAULT_WINDOW_SIZE;
    const now               = Date.now();

    let state = this.states.get(traceId);
    if (!state) {
      state = { window: [], consecutiveClassA: 0, suspicion: 0, lastUpdatedAt: now };
      this.states.set(traceId, state);
    }
    state.lastUpdatedAt = now;

    // Classify this turn relative to the previous one in the window.
    const prev: TurnRecord | null = state.window.length > 0 ? (state.window[state.window.length - 1] ?? null) : null;
    const stagnationClass  = classifyTurn(signal, prev);

    // Append fingerprinted record to the sliding window.
    const record: TurnRecord = {
      toolName:          signal.toolName,
      argsFingerprint:   signal.toolArgs   != null ? fnv1a32hex(signal.toolArgs)   : "",
      resultFingerprint: signal.toolResult != null ? fnv1a32hex(signal.toolResult) : "",
      resultStatus:      signal.resultStatus,
      stagnationClass,
    };
    state.window.push(record);
    if (state.window.length > windowSize) {
      state.window.shift();
    }

    if (stagnationClass === "exact") {
      state.consecutiveClassA++;
    } else {
      // Chain broke — halve suspicion rather than reset.
      if (state.consecutiveClassA > 0) {
        state.suspicion = Math.floor(state.suspicion / 2);
      }
      state.consecutiveClassA = 0;
    }

    // Class B suspicion — informational only, never blocks.
    if (stagnationClass === "exploration") {
      state.suspicion++;
    }

    if (state.consecutiveClassA >= classAConsecutive) {
      return {
        allowed:           false,
        reason:            `${state.consecutiveClassA} consecutive identical tool calls detected ` +
                           `(tool="${signal.toolName}", same args+result fingerprint) — ` +
                           `classAConsecutive threshold: ${classAConsecutive}`,
        dimension:         "class_a",
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

  /** Release state immediately on normal workflow completion rather than waiting for TTL. */
  evictWorkflow(traceId: string): void {
    this.states.delete(traceId);
  }

  /** Clear all state. Called during SDK shutdown. */
  shutdown(): void {
    this.states.clear();
  }

  /** Number of active loop states. Intended for tests and debug only. */
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

/**
 * Classify this turn against the previous one.
 * Class A: same tool + same args fingerprint + same result fingerprint.
 * Class B: same tool, args or result differ, both turns failed (empty/error).
 * None: tool changed, no prev turn, or current turn succeeded.
 */
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

// ---------------------------------------------------------------------------
// FNV-1a 32-bit — inlined to avoid external dependencies.
// ---------------------------------------------------------------------------

// FNV-1a 32-bit hash, hex-encoded. Fast, deterministic, not cryptographic.
function fnv1a32hex(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash  = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
