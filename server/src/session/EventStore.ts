import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { CasperEvent, CasperEventPayload } from '@casper/shared';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';

// Per-session append-only event log: a bounded in-memory ring buffer plus a
// best-effort on-disk mirror. Every event gets a strictly increasing seq, so a
// reconnecting client can replay from its last-seen seq via getSince().
export class EventStore extends EventEmitter {
  private readonly sessionId: string;
  private readonly buffer: CasperEvent[] = [];
  private readonly capacity: number;
  private seq = 0;
  private readonly log: Logger;
  private diskStream?: fs.WriteStream;

  constructor(sessionId: string, log: Logger) {
    super();
    this.sessionId = sessionId;
    this.capacity = config.eventBufferSize;
    this.log = log;
    this.openDiskMirror();
  }

  private openDiskMirror(): void {
    try {
      fs.mkdirSync(config.casperDataDir, { recursive: true });
      const file = path.join(config.casperDataDir, `${this.sessionId}.events.jsonl`);
      this.diskStream = fs.createWriteStream(file, { flags: 'a' });
    } catch (err) {
      this.log.warn({ err }, 'eventstore: could not open disk mirror');
    }
  }

  /** Append an event, assign it the next seq, persist + fan out. */
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
    if (this.diskStream) {
      this.diskStream.write(JSON.stringify(event) + '\n');
    }
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
    if (this.buffer.length === 0) return { events: [], gap: false };
    const tail = this.tail();
    // cursor >= tail-1 means everything after cursor is still buffered.
    const gap = cursor > 0 && cursor < tail - 1;
    const events = this.buffer.filter((e) => e.seq > cursor);
    return { events, gap };
  }

  dispose(): void {
    this.diskStream?.end();
    this.removeAllListeners();
  }
}
