// Session state: the folds, the event store, replay and the SQLite stores.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  CasperEvent,
  CasperEventPayload,
  DirListing,
  SessionDetail,
  SessionSummary,
} from '@casper/shared';
import { config, parseConfigDoc, pickInt, pickString } from '../server/src/config.js';
import { TurnState } from '../server/src/session/TurnState.js';
import { SessionManager, Session } from '../server/src/session/SessionManager.js';
import { EventStore } from '../server/src/session/EventStore.js';
import { closeDb, db } from '../server/src/session/db.js';
import { SessionStore } from '../server/src/session/sessionStore.js';
import { LoginStore } from '../server/src/session/logins.js';
import { hydrateTranscript } from '../server/src/session/kiroFiles.js';
import { bumpSessionToTop } from '../web/src/state/sessions.js';
import { olderPageRequest } from '../web/src/state/pagination.js';
import { noopLogger } from './helpers.js';


describe('TurnState: observability fold across a full turn', () => {
  const events: CasperEventPayload[] = [
    { kind: 'commands_available', params: { sessionId: 's', commands: [{ name: '/agent' }] } },
    { kind: 'mcp_health', params: { sessionId: 's', serverName: 'builder-mcp' }, ok: true },
    { kind: 'mcp_health', params: { sessionId: 's', serverName: 'pippin-mcp', error: 'boom' }, ok: false },
    { kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] },
    { kind: 'session_update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } },
    { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 15.9, meteringUsage: [{ value: 0.04, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 1916 } },
    { kind: 'turn_ended', stopReason: 'end_turn' },
    { kind: 'turn_started', prompt: [{ type: 'text', text: 'again' }] },
    { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 22.1, meteringUsage: [{ value: 0.06, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 3000 } },
    { kind: 'turn_ended', stopReason: 'end_turn' },
  ];
  const ts = new TurnState();
  for (const e of events) ts.apply(e);
  const snap = ts.get();

  it('cumulative credits accumulate across turns', () => {
    assert.ok(Math.abs(snap.creditsSpent - 0.1) < 1e-9, `creditsSpent=${snap.creditsSpent}`);
  });
  it('lastTurnCredits reflects most recent turn', () => {
    assert.ok(Math.abs(snap.lastTurnCredits - 0.06) < 1e-9, `lastTurnCredits=${snap.lastTurnCredits}`);
  });
  it('contextUsagePercentage takes latest value', () => {
    assert.equal(snap.contextUsagePercentage, 22.1);
  });
  it('lastTurnDurationMs takes latest value', () => {
    assert.equal(snap.lastTurnDurationMs, 3000);
  });
  it('turnStatus returns to idle after turn_ended', () => {
    assert.equal(snap.turnStatus, 'idle');
  });
  it('both MCP servers tracked', () => {
    assert.equal(snap.mcpServers.length, 2);
  });
  it('failed MCP server marked failed', () => {
    assert.equal(snap.mcpServers.find((m) => m.serverName === 'pippin-mcp')?.status, 'failed');
  });
  it('healthy MCP server marked initialized', () => {
    assert.equal(snap.mcpServers.find((m) => m.serverName === 'builder-mcp')?.status, 'initialized');
  });
  it('available commands captured', () => {
    assert.equal(snap.availableCommands.length, 1);
  });
});

describe('TurnState: compaction status', () => {
  it('compacting defaults to false', () => {
    assert.equal(new TurnState().get().compacting, false);
  });
  it('compaction started sets compacting true', () => {
    const t = new TurnState();
    t.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'started' }, summary: null } });
    assert.equal(t.get().compacting, true);
  });
  it('compaction completed clears compacting', () => {
    const t = new TurnState();
    t.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'started' }, summary: null } });
    t.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'completed' }, summary: 'sum' } });
    assert.equal(t.get().compacting, false);
  });
});

describe('TurnState: resume, crash, and oauth', () => {
  it('seed sets cumulative credits on resume', () => {
    const t = new TurnState();
    t.seed(1.5, 40);
    assert.equal(t.get().creditsSpent, 1.5);
  });
  it('seed sets context usage on resume', () => {
    const t = new TurnState();
    t.seed(1.5, 40);
    assert.equal(t.get().contextUsagePercentage, 40);
  });
  it('turnStatus running after turn_started', () => {
    const t = new TurnState();
    t.apply({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] });
    assert.equal(t.get().turnStatus, 'running');
  });
  it('process_exited resets turnStatus to idle', () => {
    // A crash mid-turn must not leave a REST refetch reporting a stuck 'running'.
    const t = new TurnState();
    t.apply({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] });
    t.apply({ kind: 'process_exited', code: 1, signal: null });
    assert.equal(t.get().turnStatus, 'idle');
  });
  it('oauth_request accumulates an oauth prompt', () => {
    const t = new TurnState();
    t.apply({ kind: 'oauth_request', params: { sessionId: 's', serverName: 'gh', url: 'https://x' } });
    assert.equal(t.get().oauthPrompts.length, 1);
  });
});

describe('EventStore.getSince + SessionManager.wire replay gating', () => {
  // kiro replays the whole conversation as notifications during session/load;
  // those must be dropped while Session.replaying is set (the transcript is
  // already hydrated from disk), and turn lifecycle events must reach turnState.
  let store: EventStore;
  let session: Session;
  let proc: EventEmitter;
  const toolCall = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x' } },
  };

  before(() => {
    const log = noopLogger();
    const mgr = new SessionManager(log) as unknown as { wire(s: unknown, proc: unknown): void };
    store = new EventStore('replay-regression-test');
    session = new Session('replay-regression-test', store, '/tmp');
    proc = new EventEmitter();
    mgr.wire(session, proc);
  });
  after(() => store.dispose());

  // Empty-buffer cursor semantics (run first, before any events are appended).
  it('empty buffer accepts a fresh cursor', () => {
    const r = store.getSince(0);
    assert.ok(!r.gap);
    assert.equal(r.events.length, 0);
  });
  it('empty buffer rejects a cursor from a prior server lifetime', () => {
    const r = store.getSince(42);
    assert.ok(r.gap);
    assert.equal(r.events.length, 0);
  });

  it('replayed notifications dropped during session/load', () => {
    session.replaying = true;
    proc.emit('notification', toolCall);
    proc.emit('notification', toolCall);
    assert.equal(store.head(), 0);
  });
  it('live notifications stored once replay finishes', () => {
    session.replaying = false;
    proc.emit('notification', toolCall);
    assert.equal(store.head(), 1);
  });

  // Turn status reaches the snapshot (mid-turn reload shows the stop button).
  it('record: idle before a turn', () => {
    assert.equal(session.turnState.get().turnStatus, 'idle');
  });
  it('record: turn_started sets turnStatus running (mid-turn refetch)', () => {
    session.record({ kind: 'turn_started', prompt: [] });
    assert.equal(session.turnState.get().turnStatus, 'running');
  });
  it('record: turn_ended returns to idle', () => {
    session.record({ kind: 'turn_ended', stopReason: 'end_turn' });
    assert.equal(session.turnState.get().turnStatus, 'idle');
  });
});

describe('SessionManager.replayHead (re-open mid-turn must not drop the prompt)', () => {
  let store: EventStore;
  let session: Session;
  let mgr: { replayHead(s: unknown, t: unknown): number };
  let evSeq: number;

  before(() => {
    const log = noopLogger();
    mgr = new SessionManager(log) as unknown as { replayHead(s: unknown, t: unknown): number };
    store = new EventStore('replayhead-test');
    session = new Session('replayhead-test', store, '/tmp');
    session.running = true;
    evSeq = session.record({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hello there' }] }).seq;
  });
  after(() => store.dispose());

  it('rewinds to replay an in-flight turn missing from hydrate', () => {
    assert.equal(mgr.replayHead(session, []), evSeq - 1);
  });
  it('no rewind when the prompt is already hydrated', () => {
    const hydrated = [{ type: 'message', message: { id: 'u1', role: 'user', text: 'hello there' } }];
    assert.equal(mgr.replayHead(session, hydrated), store.head());
  });
  it('uses head when no turn is in flight', () => {
    session.running = false;
    assert.equal(mgr.replayHead(session, []), store.head());
  });
});

describe('sidebar reorder (prompt floats the active session to the top)', () => {
  const mk = (id: string, updatedAt: string): SessionSummary =>
    ({ sessionId: id, title: id, cwd: '/', createdAt: updatedAt, updatedAt }) as SessionSummary;
  const list = [
    mk('a', '2026-07-16T10:00:00.000Z'),
    mk('b', '2026-07-16T09:00:00.000Z'),
    mk('c', '2026-07-16T08:00:00.000Z'),
  ];

  it('bumped session moves to the top', () => {
    const reordered = bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(reordered[0].sessionId, 'c');
  });
  it('the rest keep their relative order', () => {
    const reordered = bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(reordered.map((s) => s.sessionId).join(), 'c,a,b');
  });
  it('does not mutate the input array', () => {
    bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(list[0].sessionId, 'a');
  });
  it('unknown session id leaves the order unchanged', () => {
    assert.equal(
      bumpSessionToTop(list, 'missing', '2026-07-16T12:00:00.000Z').map((s) => s.sessionId).join(),
      'a,b,c',
    );
  });
});

describe('transcript pagination (older-page window walks toward index 0)', () => {
  it('full page adjacent to the window', () => {
    const full = olderPageRequest(200, 80);
    assert.equal(full.offset, 120);
    assert.equal(full.limit, 80);
  });
  it('last partial page starts at 0', () => {
    const partial = olderPageRequest(50, 80);
    assert.equal(partial.offset, 0);
    assert.equal(partial.limit, 50);
  });
  it('exact page ends at index 0', () => {
    const exact = olderPageRequest(80, 80);
    assert.equal(exact.offset, 0);
    assert.equal(exact.limit, 80);
  });
  it('nothing older -> empty request', () => {
    assert.equal(olderPageRequest(0, 80).limit, 0);
  });
  it('pages tile down to zero', () => {
    let remaining = 200;
    const offsets: number[] = [];
    while (remaining > 0) {
      const { offset, limit } = olderPageRequest(remaining, 80);
      offsets.push(offset);
      remaining -= limit;
    }
    assert.equal(offsets.join(), '120,40,0');
    assert.equal(remaining, 0);
  });
});

describe('hydrateTranscript: inline tool-result images are not shipped', () => {
  const sid = 'hydrate-image-strip-test';
  const file = path.join(config.kiroSessionsDir, `${sid}.jsonl`);

  before(() => {
    fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
    const lines = [
      {
        kind: 'AssistantMessage',
        data: {
          message_id: 'm1',
          content: [
            { kind: 'toolUse', data: { toolUseId: 'tu1', name: 'shell', input: { command: 'ls' } } },
          ],
        },
      },
      {
        kind: 'ToolResults',
        data: {
          message_id: 'm2',
          content: [
            {
              kind: 'toolResult',
              data: {
                toolUseId: 'tu1',
                status: 'success',
                content: [
                  { kind: 'text', data: { text: 'kept' } },
                  // How kiro persists a screenshot: raw bytes as a JSON number array.
                  { kind: 'image', data: { format: 'png', source: { kind: 'bytes', data: [1, 2, 3] } } },
                ],
              },
            },
          ],
        },
      },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  after(() => fs.rmSync(file, { force: true }));

  it('keeps the tool call and its text block', async () => {
    const items = await hydrateTranscript(sid);
    const call = items.find((i) => i.type === 'tool_call');
    assert.ok(call, 'tool call is hydrated');
    const blocks = (call as { tool: { content?: unknown[] } }).tool.content ?? [];
    assert.equal(blocks.length, 1, 'only the text block survives');
    assert.equal((blocks[0] as { kind: string }).kind, 'text');
  });

  it('drops the inline image block entirely', async () => {
    const items = await hydrateTranscript(sid);
    const json = JSON.stringify(items);
    assert.ok(!json.includes('"image"'), 'no image block in the hydrated transcript');
    assert.ok(!json.includes('"png"'), 'no image payload in the hydrated transcript');
  });
});

describe('hydrateTranscript: malformed entries do not crash hydration', () => {
  const sid = 'hydrate-malformed-test';
  const file = path.join(config.kiroSessionsDir, `${sid}.jsonl`);

  before(() => {
    fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
    const lines = [
      // content isn't an array
      { kind: 'AssistantMessage', data: { message_id: 'm0', content: 'not-an-array' } },
      // null and non-object entries mixed in with a real block
      {
        kind: 'AssistantMessage',
        data: {
          message_id: 'm1',
          content: [null, 42, 'str', { no_kind: true }, { kind: 'text', data: 'hello' }],
        },
      },
      // toolUse without the id it is keyed by
      {
        kind: 'AssistantMessage',
        data: { message_id: 'm2', content: [{ kind: 'toolUse', data: { name: 'shell' } }] },
      },
      // toolResult for a tool that was never announced
      {
        kind: 'ToolResults',
        data: {
          message_id: 'm3',
          content: [{ kind: 'toolResult', data: { toolUseId: 'nope', content: [] } }],
        },
      },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  after(() => fs.rmSync(file, { force: true }));

  it('hydrates without throwing and keeps the valid text', async () => {
    const items = await hydrateTranscript(sid);
    const msg = items.find(
      (i) => i.type === 'message' && (i as { message: { text: string } }).message.text === 'hello',
    );
    assert.ok(msg, 'the well-formed text block still hydrates');
  });

  it('skips a toolUse with no toolUseId', async () => {
    const items = await hydrateTranscript(sid);
    assert.equal(items.filter((i) => i.type === 'tool_call').length, 0);
  });
});

describe('SQLite stores', () => {
  let dir: string;
  const origDir = config.casperDataDir;

  const useTempDir = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-db-'));
    (config as { casperDataDir: string }).casperDataDir = dir;
    closeDb();
  };

  beforeEach(useTempDir);
  after(() => {
    closeDb();
    (config as { casperDataDir: string }).casperDataDir = origDir;
  });

  it('keeps a title and a cwd for one session in a single row', () => {
    const store = new SessionStore();
    store.setTitle('s1', 'My session');
    store.setCwd('s1', '/tmp/work');
    assert.equal(store.getTitle('s1'), 'My session');
    assert.equal(store.getCwd('s1'), '/tmp/work');
    const rows = db().prepare('SELECT count(*) c FROM sessions').get() as { c: number };
    assert.equal(rows.c, 1, 'one row, not one per field');
  });

  it('returns undefined for an override that was never set', () => {
    const store = new SessionStore();
    assert.equal(store.getTitle('nope'), undefined);
    store.setTitle('s1', 'only a title');
    assert.equal(store.getCwd('s1'), undefined, 'absent column reads as undefined, not null');
  });

  it('overwrites rather than duplicating on repeated sets', () => {
    const store = new SessionStore();
    store.setTitle('s1', 'first');
    store.setTitle('s1', 'second');
    assert.equal(store.getTitle('s1'), 'second');
    const rows = db().prepare('SELECT count(*) c FROM sessions').get() as { c: number };
    assert.equal(rows.c, 1);
  });

  it('remove clears both overrides at once', () => {
    const store = new SessionStore();
    store.setTitle('s1', 't');
    store.setCwd('s1', '/tmp');
    store.remove('s1');
    assert.equal(store.getTitle('s1'), undefined);
    assert.equal(store.getCwd('s1'), undefined);
  });

  it('a created login verifies by its raw token only', () => {
    const logins = new LoginStore();
    const { token, record } = logins.create('probe-agent');
    const found = logins.verify(token);
    assert.ok(found, 'the raw token verifies');
    assert.equal(found.id, record.id);
    assert.equal(logins.verify('some-other-token'), null);
    assert.equal(logins.verify(undefined), null);
  });

  it('stores only the hash, never the token', () => {
    const logins = new LoginStore();
    const { token } = logins.create();
    const rows = db().prepare('SELECT * FROM logins').all();
    assert.ok(!JSON.stringify(rows).includes(token), 'raw token is absent from the table');
  });

  it('lists devices newest-first and marks the caller', () => {
    const logins = new LoginStore();
    logins.create('a');
    const mine = logins.create('b');
    const list = logins.list(mine.token);
    assert.equal(list.length, 2);
    assert.equal(list.filter((d) => d.current).length, 1);
    assert.equal(list.find((d) => d.current)?.id, mine.record.id);
  });

  it('revokes one device by id and leaves the rest', () => {
    const logins = new LoginStore();
    const a = logins.create('a');
    const b = logins.create('b');
    assert.equal(logins.revokeId(a.record.id), true);
    assert.equal(logins.revokeId('no-such-id'), false);
    assert.equal(logins.verify(a.token), null);
    assert.ok(logins.verify(b.token), 'the other device still works');
  });

  it('revokeAll logs everyone out', () => {
    const logins = new LoginStore();
    const a = logins.create();
    logins.create();
    logins.revokeAll();
    assert.equal(logins.verify(a.token), null);
    assert.equal(logins.list().length, 0);
  });

  it('creates the database on first use', () => {
    closeDb();
    const store = new SessionStore();
    assert.equal(store.getTitle('anything'), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'casper.db')), true);
  });
});
