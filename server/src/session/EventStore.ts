import { EventEmitter } from 'node:events';
import type { CasperEvent, CasperEventPayload } from '@casper/shared';
import { config } from '../config.js';

// Per-session event log: a bounded in-memory ring buffer. Every event gets a
// strictly increasing seq, so a reconnecting client can replay from its
// last-seen seq via getSince(). Deliberately memory-only - a client whose cursor
// predates the buffer is told to resync and refetches the transcript instead.
export class EventStore extends EventEmitter {
  private readonly sessionId: string;
  private readonly buffer: CasperEvent[] = [];
  private readonly capacity: number;
  private seq = 0;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
    this.capacity = config.eventBufferSize;
  }

  /** Append an event, assign it the next seq, and fan it out. */
  append(payload: CasperEventPayload): CasperEvent {
    this.seq += 1;
    const event: CasperEvent = {
      seq: this.seq,
      ts: Date.now(),
      sessionId: this.sessionId,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emit('event', event);
    return event;
  }

  /** Highest assigned seq. Clients start their cursor here after a full refetch. */
  head(): number {
    return this.seq;
  }

  /** Oldest seq still in the buffer (0 if empty). */
  tail(): number {
    return this.buffer.length > 0 ? this.buffer[0]!.seq : 0;
  }

  /**
   * Events with seq > cursor, in order. Returns { events, gap } - gap is true
   * when the cursor is older than the buffer tail, meaning some events were
   * evicted and the client must resync (full transcript refetch).
   */
  getSince(cursor: number): { events: CasperEvent[]; gap: boolean } {
    // After a server restart the buffer is empty but the client may hold a
    // cursor from the previous lifetime. That's a gap: events between the
    // client's cursor and "now" were lost with the old process.
    if (this.buffer.length === 0) {
      return { events: [], gap: cursor > 0 };
    }
    const tail = this.tail();
    // cursor >= tail-1 means everything after cursor is still buffered.
    const gap = cursor > 0 && cursor < tail - 1;
    const events = this.buffer.filter((e) => e.seq > cursor);
    return { events, gap };
  }

  dispose(): void {
    this.removeAllListeners();
  }
}
