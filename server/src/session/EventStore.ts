import { EventEmitter } from 'node:events';
import type { CasperEvent, CasperEventPayload } from '@casper/shared';
import { config } from '../config.js';

// Per-session event log: a bounded in-memory ring buffer, each event with a strictly
// increasing seq. Memory-only: a client whose cursor predates the buffer resyncs by
// refetching the transcript instead.
export class EventStore extends EventEmitter {
  private readonly chatId: string;
  private readonly buffer: CasperEvent[] = [];
  private readonly capacity: number;
  private seq = 0;

  constructor(chatId: string) {
    super();
    this.chatId = chatId;
    this.capacity = config.eventBufferSize;
  }

  append(payload: CasperEventPayload): CasperEvent {
    this.seq += 1;
    const event: CasperEvent = {
      seq: this.seq,
      ts: Date.now(),
      chatId: this.chatId,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emit('event', event);
    return event;
  }

  /** Highest assigned seq; clients start their cursor here after a full refetch. */
  head(): number {
    return this.seq;
  }

  tail(): number {
    return this.buffer.length > 0 ? this.buffer[0]!.seq : 0;
  }

  /** Events with seq > cursor. `gap` is true when the cursor is older than the
   *  buffer tail, meaning evicted events the client must resync for instead. */
  getSince(cursor: number): { events: CasperEvent[]; gap: boolean } {
    // After a restart the buffer is empty but the client may hold an old cursor.
    if (this.buffer.length === 0) {
      return { events: [], gap: cursor > 0 };
    }
    const tail = this.tail();
    const gap = cursor > 0 && cursor < tail - 1;
    const events = this.buffer.filter((e) => e.seq > cursor);
    return { events, gap };
  }

  dispose(): void {
    this.removeAllListeners();
  }
}
