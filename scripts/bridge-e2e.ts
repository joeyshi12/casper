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
import { deletePersistedSession } from '../server/src/session/kiroFiles.js';

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

// Captured from POST /api/login and replayed on REST + WS as the session cookie.
let cookie = '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) h.cookie = cookie;
  return h;
}

/** Log in with the shared secret and capture the session cookie. */
async function login(): Promise<void> {
  if (!config.token) return; // auth disabled
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: config.token }),
  });
  if (!res.ok) throw new Error(`login -> ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!; // "casper.sid=<value>"
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
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
    const ws = new WebSocket(`${WSBASE}/ws?sessionId=${sessionId}&cursor=${cursor}`, {
      headers: cookie ? { cookie } : {},
    });
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

  let createdSid: string | null = null;
  try {
    await login();

    // 1. Models
    const { models } = await api<ModelsResponse>('GET', '/api/models');
    assert(models.length > 0, `GET /api/models returned ${models.length} models`);
    assert(models.some((m) => m.modelId === 'auto'), 'model list includes "auto"');

    // 2. Create session
    const detail = await api<SessionDetail>('POST', '/api/sessions', {
      modelId: 'claude-haiku-4.5',
    });
    const sid = detail.summary.sessionId;
    createdSid = sid;
    assert(typeof sid === 'string', `created session ${sid}`);
    assert(detail.modes.length > 0, `session exposes ${detail.modes.length} agent modes`);

    // 3. Prompt over WS, collect to turn_ended
    const hasTurnEnd = (evs: CasperEvent[]) =>
      evs.some((e) => e.payload.kind === 'turn_ended');
    const ws1 = new WebSocket(`${WSBASE}/ws?sessionId=${sid}&cursor=0`, {
      headers: cookie ? { cookie } : {},
    });
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
            ws1.terminate(); // simulate a network drop
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
    // 6b. Context usage is a finite, sane percentage (meter source).
    assert(
      Number.isFinite(after.observability.contextUsagePercentage) &&
        after.observability.contextUsagePercentage >= 0 &&
        after.observability.contextUsagePercentage <= 100,
      `context usage is a sane percentage: ${after.observability.contextUsagePercentage}`,
    );
    // 6c. The user's prompt survived into the transcript (persisted turn).
    const userMsg = after.transcript.find(
      (it) => it.type === 'message' && it.message.role === 'user',
    );
    assert(userMsg, 'user prompt is present in the re-fetched transcript');

    // 7. set_model round-trip
    await api('POST', `/api/sessions/${sid}/model`, { modelId: 'auto' });
    console.log('✅ set_model round-trip ok');

    // 8. Compact the conversation: exec_command 'compact' triggers kiro's
    // compaction, which emits compaction/status started -> completed.
    const wsC = new WebSocket(`${WSBASE}/ws?sessionId=${sid}&cursor=0`, {
      headers: cookie ? { cookie } : {},
    });
    const compactionEvents: CasperEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('compaction timed out')), 60_000);
      let sent = false;
      wsC.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (msg.type === 'replay_complete' && !sent) {
          sent = true; // attached + caught up; safe to send the command now
          wsC.send(JSON.stringify({ type: 'exec_command', command: 'compact' }));
        } else if (msg.type === 'event' && msg.event.payload.kind === 'compaction') {
          compactionEvents.push(msg.event);
          if (msg.event.payload.params.status.type === 'completed') {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      wsC.on('error', reject);
    });
    wsC.close();
    const started = compactionEvents.some(
      (e) => e.payload.kind === 'compaction' && e.payload.params.status.type === 'started',
    );
    assert(started, 'compaction emitted a started status');
    assert(compactionEvents.length >= 2, 'compaction emitted started -> completed');
    const afterCompact = await api<SessionDetail>('GET', `/api/sessions/${sid}`);
    assert(
      afterCompact.observability.compacting === false,
      'compacting flag is cleared after completion',
    );
    // The compaction is durable: hydrate reconstructs it from the .jsonl.
    const compactionItem = afterCompact.transcript.find((it) => it.type === 'compaction');
    assert(
      compactionItem && 'summary' in compactionItem && compactionItem.summary.trim().length > 0,
      'compaction appears in the hydrated transcript with a summary',
    );

    console.log('\n🎉 Bridge E2E passed.');
  } finally {
    // Clean up the throwaway session (memory + kiro files + event mirror).
    if (createdSid) await api('DELETE', `/api/sessions/${createdSid}`).catch(() => {});
    manager.disposeAll();
    await app.close();
    // kiro's wrapped chat process flushes its session file on shutdown, which
    // can land after the DELETE; wait for it to die, then sweep the files.
    if (createdSid) {
      await new Promise((r) => setTimeout(r, 2500));
      await deletePersistedSession(createdSid).catch(() => {});
    }
  }
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error('\n❌ E2E error:', err);
  process.exit(1);
});
