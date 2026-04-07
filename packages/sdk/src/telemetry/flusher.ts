import type { RuntimeEvent } from "../shared";

import { EventBuffer, type BufferStats } from "./buffer";
import type { TelemetryTransport } from "./transport";

// ---------------------------------------------------------------------------
// TelemetryFlusher — buffers events and drains on interval or capacity
// threshold. Network I/O is fully delegated to TelemetryTransport.
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_BUFFER_SIZE = 1_000;
const FLUSH_THRESHOLD_RATIO = 0.8;

export interface FlusherOptions {
  projectId: string;
  transport: TelemetryTransport;
  flushIntervalMs?: number;
  bufferSize?: number;
  /**
   * Called synchronously when an event is dropped due to buffer overflow.
   * Best-effort: exceptions thrown by this callback are swallowed so a
   * misbehaving caller cannot disrupt the request path.
   */
  onDrop?: (count: number) => void;
}

export interface FlusherStats {
  readonly buffer: BufferStats;
  readonly totalFlushed: number;
  readonly totalFlushes: number;
  readonly failedFlushes: number;
}

export class TelemetryFlusher {
  private readonly buffer: EventBuffer;
  private readonly transport: TelemetryTransport;
  private readonly projectId: string;
  private readonly flushIntervalMs: number;
  private readonly onDrop?: (count: number) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInProgress = false;

  private totalFlushed = 0;
  private totalFlushes = 0;
  private failedFlushes = 0;

  constructor(options: FlusherOptions) {
    this.projectId = options.projectId;
    this.transport = options.transport;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.buffer = new EventBuffer(options.bufferSize ?? DEFAULT_BUFFER_SIZE);
    this.onDrop = options.onDrop;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.(); // Don't hold the process open for telemetry
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Hot-path entry point — synchronous
  // -------------------------------------------------------------------------

  /**
   * Buffer a single event. Called from run() — must be synchronous and
   * non-throwing. Triggers an async flush if buffer is above threshold.
   */
  emit(event: RuntimeEvent): void {
    const accepted = this.buffer.push(event);
    if (!accepted) {
      // Swallow any exception from the callback — a misbehaving caller must
      // not be able to disrupt the request path through this callback.
      try {
        this.onDrop?.(1);
      } catch {
        // intentional no-op
      }
    }
    if (this.buffer.isAboveThreshold(FLUSH_THRESHOLD_RATIO)) {
      void this.flush();
    }
  }

  // -------------------------------------------------------------------------
  // Flush — async, off the hot path
  // -------------------------------------------------------------------------

  async flush(): Promise<void> {
    if (this.flushInProgress) return;
    this.flushInProgress = true;

    try {
      const events = this.buffer.drain();
      if (events.length === 0) return;

      this.totalFlushes++;
      await this.transport.send({ projectId: this.projectId, events });
      this.totalFlushed += events.length;
    } catch {
      // Final safety net — transport implementations should not throw.
      this.failedFlushes++;
    } finally {
      this.flushInProgress = false;
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  getStats(): FlusherStats {
    return {
      buffer: this.buffer.getStats(),
      totalFlushed: this.totalFlushed,
      totalFlushes: this.totalFlushes,
      failedFlushes: this.failedFlushes,
    };
  }
}
