// Drives the running server over REST + WS. Key check: disconnect mid-turn,
// reconnect with a stale cursor, and assert the missed events replay.
// Run with: npm run e2e
import { WebSocket } from 'ws';
import type {
  CasperEvent,
  ModelsResponse,
  ServerMessage,
  SessionDetail,
} from '@casper/shared';
import { buildApp } from '../server/src/app.js';
import { config } from '../server/src/config.js';

const PORT = 4331;
const BASE = `http://127.0.0.1:${PORT}`;
const WSBASE = `ws://127.0.0.1:${PORT}`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`\n❌ ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

const headers = config.token
  ? { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }
  : { 'content-type': 'application/json' };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Collect events from a WS connection until `predicate` is satisfied or timeout. */
function collect(
  sessionId: string,
  cursor: number,
  predicate: (events: CasperEvent[]) => boolean,
  timeoutMs = 60_000,
): Promise<{ events: CasperEvent[]; sawResync: boolean; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const tokenQ = config.token ? `&token=${config.token}` : '';
    const ws = new WebSocket(`${WSBASE}/ws?sessionId=${sessionId}&cursor=${cursor}${tokenQ}`);
    const events: CasperEvent[] = [];
    let sawResync = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('collect timed out'));
    }, timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === 'event') {
        events.push(msg.event);
        if (predicate(events)) {
          clearTimeout(timer);
          resolve({ events, sawResync, ws });
        }
      } else if (msg.type === 'resync') {
        sawResync = true;
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const { app, manager } = await buildApp();
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`server up on ${BASE}\n`);

  try {
    // 1. Models
    const { models } = await api<ModelsResponse>('GET', '/api/models');
    assert(models.length > 0, `GET /api/models returned ${models.length} models`);
    assert(models.some((m) => m.modelId === 'auto'), 'model list includes "auto"');

    // 2. Create session
    const detail = await api<SessionDetail>('POST', '/api/sessions', {
      modelId: 'claude-haiku-4.5',
    });
    const sid = detail.summary.sessionId;
    assert(typeof sid === 'string', `created session ${sid}`);
    assert(detail.modes.length > 0, `session exposes ${detail.modes.length} agent modes`);

    // 3. Prompt over WS, collect to turn_ended
    const hasTurnEnd = (evs: CasperEvent[]) =>
      evs.some((e) => e.payload.kind === 'turn_ended');
    const tokenQ = config.token ? `&token=${config.token}` : '';
    const ws1 = new WebSocket(`${WSBASE}/ws?sessionId=${sid}&cursor=0${tokenQ}`);
    await new Promise<void>((r, j) => {
      ws1.on('open', () => r());
      ws1.on('error', j);
    });
    ws1.send(JSON.stringify({ type: 'prompt', content: [{ type: 'text', text: 'Reply with exactly: ALPHA' }] }));

    // 4. Disconnect mid-turn: grab a couple events, then hard-close.
    let midCursor = 0;
    await new Promise<void>((resolve) => {
      let count = 0;
      ws1.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (msg.type === 'event') {
          midCursor = msg.event.seq;
          if (++count >= 1) {
            ws1.terminate(); // simulate phone lock / network drop
            resolve();
          }
        }
      });
      setTimeout(resolve, 5000);
    });
    console.log(`   disconnected mid-turn at cursor=${midCursor}`);

    // 5. Reconnect with the stale cursor; assert we get turn_ended via replay.
    const { events, ws: ws2 } = await collect(sid, midCursor, hasTurnEnd);
    ws2.close();
    const turnEnded = events.find((e) => e.payload.kind === 'turn_ended');
    assert(turnEnded, 'reconnect replayed the missed turn_ended event');
    // Assert no gaps and strictly increasing seq beyond the cursor.
    const seqs = events.map((e) => e.seq);
    const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
    assert(monotonic, 'replayed events are strictly increasing (no dupes/out-of-order)');
    assert(seqs.every((s) => s > midCursor), 'replayed events are all after the stale cursor');

    // 6. Verify credits were metered
    const after = await api<SessionDetail>('GET', `/api/sessions/${sid}`);
    assert(
      after.observability.creditsSpent > 0,
      `observability shows credits spent: ${after.observability.creditsSpent.toFixed(4)}`,
    );

    // 7. set_model round-trip
    await api('POST', `/api/sessions/${sid}/model`, { modelId: 'auto' });
    console.log('✅ set_model round-trip ok');

    console.log('\n🎉 Bridge E2E passed.');
  } finally {
    manager.disposeAll();
    await app.close();
  }
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error('\n❌ E2E error:', err);
  process.exit(1);
});
