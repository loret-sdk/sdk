import type { RuntimeEvent } from "../shared";

// ---------------------------------------------------------------------------
// EventBuffer — fixed-size ring buffer for telemetry events.
// All operations are synchronous. Never throws.
// ---------------------------------------------------------------------------

export interface BufferStats {
  readonly size: number;
  readonly capacity: number;
  /** Total events dropped due to buffer overflow since last reset. */
  readonly droppedTotal: number;
}

export class EventBuffer {
  private readonly ring: Array<RuntimeEvent | undefined>;
  private readonly capacity: number;
  private head = 0;
  private size = 0;

  private droppedTotal = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ring = new Array(capacity);
  }

  /**
   * Add an event. Synchronous, non-throwing.
   * Returns true if accepted, false if dropped (buffer full).
   * We prefer dropping new events over evicting old ones to preserve ordering.
   */
  push(event: RuntimeEvent): boolean {
    if (this.size >= this.capacity) {
      this.droppedTotal++;
      return false;
    }
    this.ring[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    this.size++;
    return true;
  }

  /**
   * Drain all buffered events in insertion order. Clears the buffer.
   * Called by TelemetryFlusher off the hot path.
   */
  drain(): RuntimeEvent[] {
    if (this.size === 0) return [];

    const events: RuntimeEvent[] = [];
    const tail = (this.head - this.size + this.capacity) % this.capacity;

    for (let i = 0; i < this.size; i++) {
      const event = this.ring[(tail + i) % this.capacity];
      if (event !== undefined) events.push(event);
    }

    // Reset
    this.head = 0;
    this.size = 0;

    return events;
  }

  get length(): number {
    return this.size;
  }

  isAboveThreshold(ratio = 0.8): boolean {
    return this.size >= this.capacity * ratio;
  }

  getStats(): BufferStats {
    return {
      size: this.size,
      capacity: this.capacity,
      droppedTotal: this.droppedTotal,
    };
  }
}
