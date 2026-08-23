// Session state: the folds, the event store, replay and the SQLite stores.
// Run with: npm test

import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  CasperEvent,
  CasperEventPayload,
  DirListing,
  ChatDetail,
  ChatSummary,
} from '@casper/shared';
import { config, parseConfigDoc, pickInt, pickString } from '../server/src/config.js';
import { TurnState } from '../server/src/session/TurnState.js';
import { SessionManager, Session } from '../server/src/session/SessionManager.js';
import { EventStore } from '../server/src/session/EventStore.js';
import { closeDb, db } from '../server/src/session/db.js';
import { ChatStore } from '../server/src/session/chatStore.js';
import { LoginStore } from '../server/src/session/logins.js';
import { hydrateTranscript, promptCount } from '../server/src/session/kiroFiles.js';
import { bumpChatToTop } from '../web/src/state/chats.js';
import { noopLogger, fakeKiroProcess, type FakeProcess } from './helpers.js';
import {
  chatDir,
  chatsRoot,
  chatUploadsDir,
  chatWorkspaceDir,
  createChatWorkspace,
  isManagedWorkspace,
} from '../server/src/session/chats.js';
import { titleFromPrompt, sanitizeTitle } from '@casper/shared';

// Fixtures go in temp directories, never the developer's real ~/.kiro. Set
// before any suite runs; node's test runner gives each file its own process, so
// this cannot leak into another file's config.
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-kiro-sessions-'));
const sessionsCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-session-cwd-')));
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;

// Each test file gets its own data directory. The runner gives each file its own process,
// so anything sharing one casper.db contends for its write lock - "database is locked" on a
// loaded CI box. Set before the first db() call, which is what opens it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-data-session-'));
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

after(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(sessionsCwd, { recursive: true, force: true });
});


describe('TurnState: the observability fold', () => {
  const started = { kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] } as const;
  const compaction = (type: 'started' | 'completed') =>
    ({ kind: 'compaction', params: { sessionId: 's', status: { type }, summary: null } }) as const;

  it('takes the latest context usage and returns to idle', () => {
    const t = new TurnState();
    for (const e of [
      started,
      { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 15.9 } },
      { kind: 'turn_ended', stopReason: 'end_turn' },
      started,
      { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 22.1 } },
      { kind: 'turn_ended', stopReason: 'end_turn' },
    ] as CasperEventPayload[]) {
      t.apply(e);
    }
    assert.equal(t.get().contextUsagePercentage, 22.1);
    assert.equal(t.get().turnStatus, 'idle');
  });

  it('runs while a turn is in flight', () => {
    const t = new TurnState();
    t.apply(started);
    assert.equal(t.get().turnStatus, 'running');
  });

  it('seeds context usage on resume', () => {
    const t = new TurnState();
    t.seed(40);
    assert.equal(t.get().contextUsagePercentage, 40);
  });

  it('tracks a compaction from start to finish', () => {
    const t = new TurnState();
    assert.equal(t.get().compacting, false);
    t.apply(compaction('started'));
    assert.equal(t.get().compacting, true);
    t.apply(compaction('completed'));
    assert.equal(t.get().compacting, false);
  });

  // A crash mid-turn must not leave a REST refetch reporting a stuck 'running'.
  it('resets turnStatus when the process exits', () => {
    const t = new TurnState();
    t.apply(started);
    t.apply({ kind: 'process_exited', code: 1, signal: null });
    assert.equal(t.get().turnStatus, 'idle');
  });

  // Only a completed/failed notification clears it, and a killed process sends neither.
  // Left set, the flag disables the composer for the life of the server.
  it('clears compacting when the process exits, which nothing else would', () => {
    const t = new TurnState();
    t.apply(compaction('started'));
    t.apply({ kind: 'process_exited', code: null, signal: 'SIGTERM' });
    assert.equal(t.get().compacting, false);
  });
});

describe('EventStore.getSince + replay gating', () => {
  // kiro replays the whole conversation as notifications during session/load;
  // those must be dropped while Session.replaying is set (the transcript is
  // already hydrated from disk), and turn lifecycle events must reach turnState.
  // Driven through createSession so the wiring under test is the real one.
  let mgr: SessionManager;
  let store: EventStore;
  let session: Session;
  let proc: FakeProcess;
  const toolCall = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x' } },
  };

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'replay-regression-test' });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    session = await mgr.ensureOpen(detail.summary.chatId);
    store = session.store;
  });
  after(() => mgr.disposeAll());

  it('adopts the session id kiro assigned', () => {
    assert.equal(session.sessionId, 'replay-regression-test');
  });

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
    proc.bus.emit('notification', toolCall);
    proc.bus.emit('notification', toolCall);
    assert.equal(store.head(), 0);
  });
  it('live notifications stored once replay finishes', () => {
    session.replaying = false;
    proc.bus.emit('notification', toolCall);
    assert.equal(store.head(), 1);
  });

  // Only the session's current process may mutate its state.
  it('an exit from a replaced process is ignored', () => {
    const head = store.head();
    session.proc = undefined;
    proc.bus.emit('exit', 1, null);
    assert.equal(store.head(), head, 'a stale process must not record an exit');
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

describe('re-open mid-turn must not drop the prompt', () => {
  // The head a reconnecting client is given: kiro only writes a turn to its
  // jsonl once the turn completes, so an in-flight one is missing from the
  // hydrated transcript and has to be replayed from the event store. Read
  // through getDetail, which is how a client actually asks.
  let mgr: SessionManager;
  let session: Session;
  let chatId: string;
  let evSeq: number;

  before(async () => {
    mgr = new SessionManager(noopLogger(), {
      spawn: () => fakeKiroProcess({ sessionId: 'replayhead-test' }),
    });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    session = await mgr.ensureOpen(chatId);
    session.running = true;
    evSeq = session.record({
      kind: 'turn_started',
      prompt: [{ type: 'text', text: 'hello there' }],
    }).seq;
  });
  after(() => mgr.disposeAll());

  it('rewinds to replay an in-flight turn missing from hydrate', async () => {
    const detail = await mgr.getDetail(chatId);
    assert.equal(detail.head, evSeq - 1);
  });

  it('no rewind when the prompt is already hydrated', async () => {
    const file = path.join(config.kiroSessionsDir, `${session.sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        kind: 'Prompt',
        data: { message_id: 'u1', content: [{ kind: 'text', data: { text: 'hello there' } }] },
      }) + '\n',
    );
    try {
      const detail = await mgr.getDetail(chatId);
      assert.equal(detail.head, session.store.head());
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('uses head when no turn is in flight', async () => {
    session.running = false;
    const detail = await mgr.getDetail(chatId);
    assert.equal(detail.head, session.store.head());
  });
});

describe('sidebar reorder (prompt floats the active session to the top)', () => {
  const mk = (id: string, updatedAt: string): ChatSummary =>
    ({ chatId: id, title: id, cwd: '/', createdAt: updatedAt, updatedAt }) as ChatSummary;
  const list = [
    mk('a', '2026-07-16T10:00:00.000Z'),
    mk('b', '2026-07-16T09:00:00.000Z'),
    mk('c', '2026-07-16T08:00:00.000Z'),
  ];

  it('bumped session moves to the top', () => {
    const reordered = bumpChatToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(reordered[0].chatId, 'c');
  });
  it('the rest keep their relative order', () => {
    const reordered = bumpChatToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(reordered.map((s) => s.chatId).join(), 'c,a,b');
  });
  it('does not mutate the input array', () => {
    bumpChatToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(list[0].chatId, 'a');
  });
  it('unknown chat id leaves the order unchanged', () => {
    assert.equal(
      bumpChatToTop(list, 'missing', '2026-07-16T12:00:00.000Z').map((s) => s.chatId).join(),
      'a,b,c',
    );
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

// The identity problem: a live message is keyed by Casper's event seq and a rebuilt one by
// kiro's message_id, so neither side can use the other's. Position is the only key both can
// compute, which makes this the load-bearing test for the whole scheme.
describe('hydrateTranscript: attachments land on the right message by position', () => {
  const sid = 'hydrate-attachments-test';
  const file = path.join(config.kiroSessionsDir, `${sid}.jsonl`);
  const prompt = (text: string) => ({
    kind: 'Prompt',
    data: { content: [{ kind: 'text', data: { text } }] },
  });

  before(() => {
    fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify(prompt('first')),
        JSON.stringify({ kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: { text: 'ok' } }] } }),
        JSON.stringify(prompt('Attached files: /up/a.zip\nsecond')),
        JSON.stringify(prompt('third')),
      ].join('\n'),
    );
  });
  after(() => fs.rmSync(file, { force: true }));

  const users = (items: Awaited<ReturnType<typeof hydrateTranscript>>) =>
    items.filter((it) => it.type === 'message' && it.message.role === 'user');

  it('gives the attachment to the second user message, not the first or third', async () => {
    const zip = { path: '/up/a.zip', name: 'a.zip', size: 12, kind: 'binary' as const };
    const items = await hydrateTranscript(sid, new Map([[1, [zip]]]));
    const msgs = users(items);
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0]!.type === 'message' && msgs[0]!.message.attachments, undefined);
    assert.deepEqual(
      msgs[1]!.type === 'message' ? msgs[1]!.message.attachments : null,
      [zip],
      'ordinal 1 is the second user message, counting assistant turns out',
    );
    assert.equal(msgs[2]!.type === 'message' && msgs[2]!.message.attachments, undefined);
  });

  it('strips the paths line from what is displayed', async () => {
    const items = await hydrateTranscript(sid, new Map());
    const second = users(items)[1]!;
    const text = second.type === 'message' ? second.message.text : '';
    assert.equal(text, 'second', 'the machine-facing line never reaches the bubble');
  });

  // The writer and the reader must count the same thing. Counting *rendered* messages while
  // hydration counted *Prompt entries* meant an attachment-only prompt was seen by one and
  // not the other, and every later attachment was filed one message too early.
  it('counts a prompt that carried only an attachment', async () => {
    const box = path.join(config.kiroSessionsDir, 'ordinal-count-test.jsonl');
    fs.writeFileSync(
      box,
      [
        // No text of its own: just the machine-facing line, which strips to nothing.
        JSON.stringify(prompt('Attached files: /up/a.zip\n')),
        JSON.stringify(prompt('second')),
      ].join('\n'),
    );
    try {
      assert.equal(
        await promptCount('ordinal-count-test'),
        2,
        'both prompts count, so the next attachment is filed at 2',
      );
    } finally {
      fs.rmSync(box, { force: true });
    }
  });

  it('agrees with the ordinal hydration reads back', async () => {
    const box = path.join(config.kiroSessionsDir, 'ordinal-agree-test.jsonl');
    fs.writeFileSync(
      box,
      [JSON.stringify(prompt('Attached files: /up/a.zip\n')), JSON.stringify(prompt('second'))].join('\n'),
    );
    try {
      const zip = { path: '/up/a.zip', name: 'a.zip', size: 1, kind: 'binary' as const };
      // Written at the ordinal the first prompt would have taken.
      const items = await hydrateTranscript('ordinal-agree-test', new Map([[0, [zip]]]));
      const users = items.filter((it) => it.type === 'message' && it.message.role === 'user');
      assert.equal(users.length, 2);
      assert.deepEqual(
        users[0]!.type === 'message' ? users[0]!.message.attachments : null,
        [zip],
        'lands on the attachment-only prompt, not the one after it',
      );
    } finally {
      fs.rmSync(box, { force: true });
    }
  });

  it('keeps a message that had only an attachment and no text', async () => {
    const only = path.join(config.kiroSessionsDir, 'attach-only-test.jsonl');
    fs.writeFileSync(only, JSON.stringify(prompt('Attached files: /up/a.zip\n')));
    try {
      const zip = { path: '/up/a.zip', name: 'a.zip', size: 1, kind: 'binary' as const };
      const items = await hydrateTranscript('attach-only-test', new Map([[0, [zip]]]));
      assert.equal(users(items).length, 1, 'an attachment alone is still a message');
    } finally {
      fs.rmSync(only, { force: true });
    }
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

  // Attachments are recorded per message so the transcript never has to parse the
  // "Attached files:" line back out of the prose it was written into.
  it('round-trips attachments, grouped by the message they belong to', () => {
    const store = new ChatStore();
    store.setAttachments('s1', 0, [
      { path: '/up/a.zip', name: 'a.zip', size: 2048, kind: 'binary' },
      { path: '/up/b.png', name: 'b.png', size: 99, kind: 'image' },
    ]);
    store.setAttachments('s1', 3, [{ path: '/up/c.txt', name: 'c.txt', size: 7, kind: 'text' }]);

    const got = store.attachmentsByChat('s1');
    assert.deepEqual([...got.keys()].sort(), [0, 3]);
    assert.deepEqual(got.get(0)!.map((a) => a.name), ['a.zip', 'b.png']);
    assert.equal(got.get(0)![0]!.size, 2048);
    assert.equal(got.get(3)!.length, 1);
  });

  it('keeps one session\'s attachments out of another\'s', () => {
    const store = new ChatStore();
    store.setAttachments('s1', 0, [{ path: '/up/a.zip', name: 'a.zip', size: 1, kind: 'binary' }]);
    assert.equal(store.attachmentsByChat('s2').size, 0);
  });

  it('re-recording the same file at the same message does not duplicate it', () => {
    const store = new ChatStore();
    const one = { path: '/up/a.zip', name: 'a.zip', size: 1, kind: 'binary' as const };
    store.setAttachments('s1', 0, [one]);
    store.setAttachments('s1', 0, [one]);
    assert.equal(store.attachmentsByChat('s1').get(0)!.length, 1);
  });

  it('deleting a session forgets its attachments too', () => {
    const store = new ChatStore();
    store.setAttachments('s1', 0, [{ path: '/up/a.zip', name: 'a.zip', size: 1, kind: 'binary' }]);
    store.remove('s1');
    assert.equal(store.attachmentsByChat('s1').size, 0);
  });

  it('keeps a title and a cwd for one session in a single row', () => {
    const store = new ChatStore();
    store.setTitle('s1', 'My session');
    store.setCwd('s1', '/tmp/work');
    assert.equal(store.getTitle('s1'), 'My session');
    assert.equal(store.getCwd('s1'), '/tmp/work');
    const rows = db().prepare('SELECT count(*) c FROM chats').get() as { c: number };
    assert.equal(rows.c, 1, 'one row, not one per field');
  });

  it('returns undefined for an override that was never set', () => {
    const store = new ChatStore();
    assert.equal(store.getTitle('nope'), undefined);
    store.setTitle('s1', 'only a title');
    assert.equal(store.getCwd('s1'), undefined, 'absent column reads as undefined, not null');
  });

  it('overwrites rather than duplicating on repeated sets', () => {
    const store = new ChatStore();
    store.setTitle('s1', 'first');
    store.setTitle('s1', 'second');
    assert.equal(store.getTitle('s1'), 'second');
    const rows = db().prepare('SELECT count(*) c FROM chats').get() as { c: number };
    assert.equal(rows.c, 1);
  });

  it('remove clears both overrides at once', () => {
    const store = new ChatStore();
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
    const store = new ChatStore();
    assert.equal(store.getTitle('anything'), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'casper.db')), true);
  });
});

describe('default agent', () => {
  // Asking for an agent that does not exist is safe: kiro-cli acp falls back to
  // kiro_default instead of failing, and reports the choice in session/new, which
  // SessionManager adopts (s.agentId = res.modes.currentModeId). Verified against
  // kiro 2.11: requesting a missing agent returned currentModeId kiro_default.
  it('is the casper agent, which is the one carrying the widget tools', () => {
    assert.equal(config.defaultAgent, 'casper');
  });
});

// AGENTS.md: never write into ~/.casper from a test. Importing a route module used to break
// that - auth.ts built a LoginStore at module scope, which prunes on construction, so the
// database opened as an import side effect before any test could redirect it. Schema changes
// then landed in the developer's real casper.db.
describe('importing a module does not touch the data directory', () => {
  it('opens no database until something asks for one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-import-'));
    (config as { casperDataDir: string }).casperDataDir = dir;
    closeDb();

    // The module whose import used to do it, plus the manager whose constructor did later,
    // when a one-off migration was called from there.
    await import('../server/src/routes/auth.js');
    await import('../server/src/session/SessionManager.js');

    assert.equal(
      fs.existsSync(path.join(dir, 'casper.db')),
      false,
      'importing opened a database; it must wait for a real request',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the chat a session belongs to', () => {
  let dir: string;
  const origDir = config.casperDataDir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-chatid-'));
    (config as { casperDataDir: string }).casperDataDir = dir;
    closeDb();
  });
  after(() => {
    closeDb();
    (config as { casperDataDir: string }).casperDataDir = origDir;
  });

  it('remembers the chat id the client minted', () => {
    const store = new ChatStore();
    const chatId = crypto.randomUUID();
    store.bindSession(chatId, 'sess-1');
    assert.equal(store.chatIdForSession('sess-1'), chatId);
  });

  it('has no chat for a session Casper did not start', () => {
    const store = new ChatStore();
    assert.equal(store.chatIdForSession('someone-elses-session'), undefined);
  });

  it('keeps the chat id when another override is written', () => {
    const store = new ChatStore();
    const chatId = crypto.randomUUID();
    store.bindSession(chatId, 'sess-2');
    store.setTitle('sess-2', 'renamed');
    store.setCwd('sess-2', '/tmp');
    assert.equal(store.chatIdForSession('sess-2'), chatId);
    assert.equal(store.getTitle('sess-2'), 'renamed');
  });
});

describe('the chat directory layout', () => {
  // The whole point of a chat id: it exists before kiro has named a session, so a brand-new
  // chat has somewhere to put an upload. Keying this on the session id is what made a first
  // message unable to carry a file.
  it('puts uploads and the workspace under one directory the chat owns', () => {
    const chatId = crypto.randomUUID();
    assert.equal(chatDir(chatId), path.join(chatsRoot(), chatId));
    assert.equal(chatUploadsDir(chatId), path.join(chatsRoot(), chatId, 'uploads'));
    assert.equal(chatWorkspaceDir(chatId), path.join(chatsRoot(), chatId, 'workspace'));
  });

  it('creates the workspace on demand, private to the user', () => {
    const dir = createChatWorkspace(crypto.randomUUID());
    try {
      assert.equal(fs.existsSync(dir), true);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A chat pointed at a directory the user picked never gets one, so the uploads directory
  // has to stand on its own rather than being a sibling of a workspace that must exist.
  it('does not require a workspace to have an uploads directory', () => {
    const chatId = crypto.randomUUID();
    assert.equal(fs.existsSync(chatWorkspaceDir(chatId)), false);
    assert.ok(chatUploadsDir(chatId).startsWith(chatDir(chatId)));
  });

  // Drives whether the session list shows a folder name: a directory Casper made gets none.
  it('tells a workspace it made from a directory the user picked', () => {
    assert.equal(isManagedWorkspace(chatWorkspaceDir(crypto.randomUUID())), true);
    assert.equal(isManagedWorkspace('/home/someone/projects/thing'), false);
  });
});

describe('naming a session after its first prompt', () => {
  const text = (t: string) => [{ type: 'text' as const, text: t }];

  it('uses the prompt', () => {
    assert.equal(titleFromPrompt(text('Fix the transcript follow bug')), 'Fix the transcript follow bug');
  });

  it('drops trailing punctuation', () => {
    assert.equal(titleFromPrompt(text('why did the dots stop showing?')), 'why did the dots stop showing');
  });

  it('collapses newlines and runs of space', () => {
    assert.equal(titleFromPrompt(text('Fix   the\n\nscrollbar')), 'Fix the scrollbar');
  });

  it('cuts long prompts at a word boundary', () => {
    const long = 'Remove the friction about starting new sessions so that clicking new goes straight in';
    const out = titleFromPrompt(text(long));
    assert.ok(out.length <= 61, `${out.length} chars: ${out}`);
    assert.ok(out.endsWith('…'), out);
    assert.ok(!out.includes('  '), out);
    assert.ok(long.startsWith(out.slice(0, -1)), out);
  });

  // The attachments line is machine-facing; without this every message with a file
  // would be titled after the upload path.
  it('ignores the attachments line', () => {
    const withFile = 'Attached files: /home/j/.casper/sessions/x/uploads/a.png\nwhat is wrong here';
    assert.equal(titleFromPrompt(text(withFile)), 'what is wrong here');
  });

  it('ignores fenced code, which says nothing about the topic', () => {
    assert.equal(titleFromPrompt(text('why does this fail\n\n```ts\nconst x = 1;\n```')), 'why does this fail');
  });

  // An image with no words: leave the existing name rather than setting a blank one.
  it('gives nothing back for a promptless message', () => {
    assert.equal(titleFromPrompt([{ type: 'image', mimeType: 'image/png', data: 'x' } as never]), '');
    assert.equal(titleFromPrompt(text('   ')), '');
  });
});

// These reach SessionManager through its public surface only. Before the spawn
// seam existed they were unreachable without spawning a real kiro-cli.
describe('process lifecycle', () => {
  const managerWith = (spawn: () => FakeProcess) =>
    new SessionManager(noopLogger(), { spawn });

  it('adopts the id kiro assigns to a brand-new session', async () => {
    const mgr = managerWith(() => fakeKiroProcess({ sessionId: 'assigned-by-kiro' }));
    try {
      const detail = await mgr.createChat({ cwd: sessionsCwd });
      assert.equal(detail.summary.sessionId, 'assigned-by-kiro');
      // The temporary pending- id must not survive as a second entry.
      const ids = (await mgr.listChats()).map((s) => s.sessionId);
      assert.deepEqual(ids.filter((id) => id.startsWith('pending-')), []);
    } finally {
      mgr.disposeAll();
    }
  });

  it('loads rather than creates a session that has been live before', async () => {
    const proc = fakeKiroProcess({ sessionId: 'reload-me' });
    const mgr = managerWith(() => proc);
    try {
      const detail = await mgr.createChat({ cwd: sessionsCwd });
      assert.deepEqual(proc.calls, ['newSession']);

      // Drop the process, then act again: the session has been live, so kiro is
      // asked to load it and replay rather than to create a new one.
      const s = await mgr.ensureOpen(detail.summary.chatId);
      s.proc = undefined;
      await mgr.setModel(detail.summary.chatId, 'model-2');
      assert.deepEqual(proc.calls, ['newSession', 'loadSession', 'setModel']);
    } finally {
      mgr.disposeAll();
    }
  });

  it('a failed handshake leaves no half-created session behind', async () => {
    const mgr = managerWith(() =>
      fakeKiroProcess({
        onInitialize: async () => {
          throw new Error('credentials have expired');
        },
      }),
    );
    try {
      await assert.rejects(
        mgr.createChat({ cwd: sessionsCwd }),
        /credentials have expired/,
      );
      assert.deepEqual(await mgr.listChats(), []);
      assert.equal(mgr.liveCount, 0);
    } finally {
      mgr.disposeAll();
    }
  });

  it('evicts the idlest process when at capacity, keeping the busy one', async () => {
    const cap = config.maxLiveSessions;
    (config as { maxLiveSessions: number }).maxLiveSessions = 2;
    const spawned: FakeProcess[] = [];
    const mgr = managerWith(() => {
      const p = fakeKiroProcess({ sessionId: `session-${spawned.length + 1}` });
      spawned.push(p);
      return p;
    });
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'session-1' });
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'session-2' });
      assert.equal(mgr.liveCount, 2);

      // Mark the first busy so it cannot be the victim, and make the second the
      // idlest by age.
      const first = await mgr.ensureOpen('session-1');
      first.running = true;
      const second = await mgr.ensureOpen('session-2');
      second.lastActivity = 0;

      await mgr.createChat({ cwd: sessionsCwd, chatId: 'session-3' });
      assert.equal(spawned[1]?.disposed(), true, 'the idle process should be evicted');
      assert.equal(spawned[0]?.disposed(), false, 'a running turn must not be evicted');
    } finally {
      (config as { maxLiveSessions: number }).maxLiveSessions = cap;
      mgr.disposeAll();
    }
  });

  // kiro's file still says the old directory - its shutdown write uses the cwd it was spawned
  // with - so the override is the only record until a turn completes in the new one. Keyed by
  // chat, which a chat id equal to its session id would not have caught.
  it('remembers a re-pointed directory across a dormant reopen', async () => {
    const mgr = managerWith(() => fakeKiroProcess({ sessionId: 'kiro-side-id' }));
    const moved = path.join(sessionsCwd, 'moved-elsewhere');
    fs.mkdirSync(moved, { recursive: true });
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'chat-side-id' });
      await mgr.setChatCwd('chat-side-id', moved);

      // What kiro leaves behind: the directory it was spawned in, not the new one.
      fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(config.kiroSessionsDir, 'kiro-side-id.json'),
        JSON.stringify({ session_id: 'kiro-side-id', cwd: sessionsCwd }),
      );
      // Drop it from memory so the next open has to read the override back.
      mgr.disposeAll();

      const reopened = await mgr.ensureOpen('chat-side-id');
      assert.equal(reopened.cwd, moved, 'the override must be found by chat id');
    } finally {
      mgr.disposeAll();
      fs.rmSync(path.join(config.kiroSessionsDir, 'kiro-side-id.json'), { force: true });
    }
  });

  it('re-pointing the working directory drops the process spawned in the old one', async () => {
    const proc = fakeKiroProcess({ sessionId: 'repoint-me' });
    const mgr = managerWith(() => proc);
    const target = path.join(sessionsCwd, 'moved');
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'repoint-me' });
      assert.equal(mgr.liveCount, 1);
      await mgr.setChatCwd('repoint-me', target);
      assert.equal(proc.disposed(), true);
      assert.equal(mgr.liveCount, 0, 'the next turn respawns in the new directory');
      assert.equal(await mgr.getChatCwd('repoint-me'), target);
    } finally {
      mgr.disposeAll();
    }
  });
});

// kiro binds the agent definition, the workspace's .kiro directory and its MCP
// servers when the child starts, and offers no ACP method to re-read them, so a
// reload is a process replacement.
describe('reloading a session re-detects its setup', () => {
  const managerWithSpawns = (spawned: FakeProcess[]) =>
    new SessionManager(noopLogger(), {
      spawn: () => {
        const p = fakeKiroProcess({ sessionId: 'reloadable' });
        spawned.push(p);
        return p;
      },
    });

  // A reload is a load, and kiro can only load a session whose event log has
  // entries. Stand in for what a completed turn leaves behind.
  const persist = (sessionId: string) => {
    const store = new ChatStore();
    store.create(sessionId);
    store.bindSession(sessionId, sessionId);
    fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(config.kiroSessionsDir, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, cwd: sessionsCwd }),
    );
    fs.writeFileSync(
      path.join(config.kiroSessionsDir, `${sessionId}.jsonl`),
      JSON.stringify({
        kind: 'Prompt',
        data: { message_id: 'm1', content: [{ kind: 'text', data: { text: 'hi' } }] },
      }) + '\n',
    );
  };
  const unpersist = (sessionId: string) => {
    for (const ext of ['json', 'jsonl']) {
      fs.rmSync(path.join(config.kiroSessionsDir, `${sessionId}.${ext}`), { force: true });
    }
  };

  afterEach(() => unpersist('reloadable'));

  it('replaces the process and loads the session back into the new one', async () => {
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      assert.deepEqual(spawned[0]?.calls, ['newSession']);
      persist('reloadable');

      await mgr.reloadChat('reloadable');
      assert.equal(spawned.length, 2, 'a second process should have been spawned');
      // Awaited out, not just signalled: kiro flushes its session file on exit and
      // the replacement reads that file.
      assert.ok(spawned[0]?.calls.includes('disposeAndWait'));
      // The transcript comes back via load, not a fresh session.
      assert.deepEqual(spawned[1]?.calls, ['loadSession']);
    } finally {
      mgr.disposeAll();
    }
  });

  it('leaves the session live, so the next prompt does not respawn again', async () => {
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      persist('reloadable');
      await mgr.reloadChat('reloadable');
      assert.equal(mgr.liveCount, 1);
    } finally {
      mgr.disposeAll();
    }
  });

  it('records no process_exited for a deliberate restart', async () => {
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      persist('reloadable');
      const before = mgr.getStore('reloadable')!.getSince(0).events.length;
      await mgr.reloadChat('reloadable');
      // The fake exits on demand; emit what a real child emits as it shuts down.
      spawned[0]!.bus.emit('exit', 0, null);
      const kinds = mgr
        .getStore('reloadable')!
        .getSince(0)
        .events.slice(before)
        .map((e) => e.payload.kind);
      assert.deepEqual(kinds.filter((k) => k === 'process_exited'), []);
    } finally {
      mgr.disposeAll();
    }
  });

  it('refuses to reload while a turn is running', async () => {
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      persist('reloadable');
      (await mgr.ensureOpen('reloadable')).running = true;
      await assert.rejects(mgr.reloadChat('reloadable'), /turn is running/);
      assert.equal(spawned.length, 1, 'the running turn keeps its process');
    } finally {
      mgr.disposeAll();
    }
  });

  it('refuses to reload while the conversation is being compacted', async () => {
    // Compaction is not a turn, so the running guard says nothing about it. Replacing the
    // process would lose the work and strand the compacting flag, which this reload would
    // then hand back to the client in the detail it returns.
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      persist('reloadable');
      const s = await mgr.ensureOpen('reloadable');
      s.record({
        kind: 'compaction',
        params: { sessionId: 'reloadable', status: { type: 'started' }, summary: null },
      });

      await assert.rejects(mgr.reloadChat('reloadable'), /being compacted/);
      assert.equal(spawned.length, 1, 'the process doing the work is left alone');
      assert.equal(spawned[0]?.disposed(), false);
    } finally {
      mgr.disposeAll();
    }
  });

  it('reloads once the compaction finishes', async () => {
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      persist('reloadable');
      const s = await mgr.ensureOpen('reloadable');
      const compaction = (type: 'started' | 'completed') =>
        s.record({
          kind: 'compaction',
          params: { sessionId: 'reloadable', status: { type }, summary: null },
        });
      compaction('started');
      compaction('completed');

      await mgr.reloadChat('reloadable');
      assert.equal(spawned.length, 2, 'no longer blocked once it is done');
    } finally {
      mgr.disposeAll();
    }
  });

  it('refuses a session with no recorded turn, keeping the process it has', async () => {
    // kiro creates the event log empty at session/new and refuses to load a session
    // that has nothing in it. Tearing the process down first would replace a working
    // one with a process that answers "Session not found".
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      // The files exist, as kiro's do from creation; the event log is empty.
      fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(config.kiroSessionsDir, 'reloadable.json'),
        JSON.stringify({ session_id: 'reloadable', cwd: sessionsCwd }),
      );
      fs.writeFileSync(path.join(config.kiroSessionsDir, 'reloadable.jsonl'), '');

      await assert.rejects(mgr.reloadChat('reloadable'), /has not saved this session/);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0]?.disposed(), false, 'the live process must survive');
      assert.equal(mgr.liveCount, 1);
    } finally {
      mgr.disposeAll();
    }
  });

  it('reports the reloaded session, so the client can apply it', async () => {
    const spawned: FakeProcess[] = [];
    const mgr = managerWithSpawns(spawned);
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
      persist('reloadable');
      const detail = await mgr.reloadChat('reloadable');
      assert.equal(detail.summary.sessionId, 'reloadable');
      assert.equal(detail.summary.liveness, 'live');
      // The modes are the fresh process's, not the disposed one's cached copy.
      assert.deepEqual(detail.modes.map((m) => m.id), ['casper']);
    } finally {
      mgr.disposeAll();
    }
  });

  // A message sent while the process is being replaced used to be handed the process
  // the reload was about to dispose, which killed the turn mid-flight. It must wait
  // for the replacement instead.
  describe('a message sent mid-reload', () => {
    /** A manager whose first process holds its shutdown open until released. */
    const gatedManager = (spawned: FakeProcess[]) => {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const mgr = new SessionManager(noopLogger(), {
        spawn: () => {
          const first = spawned.length === 0;
          const p = fakeKiroProcess({
            sessionId: 'reloadable',
            ...(first ? { onDisposeAndWait: () => held } : {}),
          });
          spawned.push(p);
          return p;
        },
      });
      return { mgr, release };
    };

    const waitFor = async (what: string, ok: () => boolean, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ok()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail(`timed out waiting for ${what}`);
    };

    it('runs on the replacement process, never on the one being disposed', async () => {
      const spawned: FakeProcess[] = [];
      const { mgr, release } = gatedManager(spawned);
      try {
        await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
        persist('reloadable');

        const reload = mgr.reloadChat('reloadable');
        // Hold it at shutdown: this is the window the prompt used to slip into.
        await waitFor('the reload to reach shutdown', () =>
          spawned[0]!.calls.includes('disposeAndWait'),
        );

        const prompt = mgr.runPrompt('reloadable', [{ type: 'text', text: 'hi' }]);
        // No wait needed, and none wanted: the prompt cannot reach a process until
        // release() below lets the reload finish, so this holds by causality.
        assert.ok(
          !spawned[0]!.calls.includes('prompt'),
          'the process being disposed must never be prompted',
        );
        assert.equal(spawned.length, 1, 'no process is spawned until the old one is gone');

        release();
        await reload;
        await prompt;

        assert.equal(spawned.length, 2);
        assert.ok(
          spawned[1]!.calls.includes('prompt'),
          'the turn should run on the replacement',
        );
      } finally {
        mgr.disposeAll();
      }
    });

    it('still records exactly one turn_started', async () => {
      const spawned: FakeProcess[] = [];
      const { mgr, release } = gatedManager(spawned);
      try {
        await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
        persist('reloadable');
        const reload = mgr.reloadChat('reloadable');
        await waitFor('shutdown', () => spawned[0]!.calls.includes('disposeAndWait'));
        const prompt = mgr.runPrompt('reloadable', [{ type: 'text', text: 'hi' }]);
        release();
        await reload;
        await prompt;

        const starts = mgr
          .getStore('reloadable')!
          .getSince(0)
          .events.filter((e) => e.payload.kind === 'turn_started');
        assert.equal(starts.length, 1);
      } finally {
        mgr.disposeAll();
      }
    });

    it('refuses a second reload while one is already running', async () => {
      const spawned: FakeProcess[] = [];
      const { mgr, release } = gatedManager(spawned);
      try {
        await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
        persist('reloadable');
        const first = mgr.reloadChat('reloadable');
        await waitFor('shutdown', () => spawned[0]!.calls.includes('disposeAndWait'));

        await assert.rejects(mgr.reloadChat('reloadable'), /already running/);

        release();
        await first;
        assert.equal(spawned.length, 2, 'only one replacement process');
      } finally {
        mgr.disposeAll();
      }
    });

    // The other direction. A prompt on a dormant session spends seconds in ensureProc
    // before it has a process; a reload entering that gap used to see no turn, drain the
    // spawn, and dispose the very child the prompt was about to be sent to.
    it('is refused when a prompt is still spawning its process', async () => {
      const spawned: FakeProcess[] = [];
      let releaseInit!: () => void;
      const initGate = new Promise<void>((r) => {
        releaseInit = r;
      });
      let gateInit = false;
      const mgr = new SessionManager(noopLogger(), {
        spawn: () => {
          const p = fakeKiroProcess({
            sessionId: 'reloadable',
            ...(gateInit
              ? {
                  onInitialize: async () => {
                    await initGate;
                    return {};
                  },
                }
              : {}),
          });
          spawned.push(p);
          return p;
        },
      });
      try {
        await mgr.createChat({ cwd: sessionsCwd, chatId: 'reloadable' });
        persist('reloadable');
        // Dormant, so the prompt has to spawn before it can send anything.
        (await mgr.ensureOpen('reloadable')).proc = undefined;
        gateInit = true;

        const prompt = mgr.runPrompt('reloadable', [{ type: 'text', text: 'hi' }]);
        await waitFor('the respawn to begin', () => spawned.length === 2);

        // The timer is a hang detector, not a wait: before the fix the reload drained
        // s.spawning and never returned while initialize was held.
        const outcome = await Promise.race([
          mgr.reloadChat('reloadable').then(
            () => 'reloaded',
            (e: Error) => e.message,
          ),
          new Promise<string>((r) => setTimeout(() => r('hung'), 500)),
        ]);
        assert.match(outcome, /turn is running/);

        releaseInit();
        await prompt;
        assert.equal(spawned.length, 2, 'the reload spawned nothing of its own');
      } finally {
        releaseInit();
        mgr.disposeAll();
      }
    });
  });
});

describe('session summary: one projection over kiro’s file and live state', () => {
  /** A chat row pointing at a session file: what makes it one of Casper's, and listed. */
  const linkChat = (sessionId: string): void => {
    const store = new ChatStore();
    store.create(sessionId);
    store.bindSession(sessionId, sessionId);
  };

  const writeSessionFile = (
    sessionId: string,
    over: Record<string, unknown> = {},
  ): void => {
    fs.mkdirSync(config.kiroSessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(config.kiroSessionsDir, `${sessionId}.json`),
      JSON.stringify({
        session_id: sessionId,
        title: 'kiro title',
        cwd: sessionsCwd,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        session_state: {
          agent_name: 'file-agent',
          rts_model_state: {
            context_usage_percentage: 42,
            model_info: { model_id: 'file-model' },
          },
          conversation_metadata: {
            user_turn_metadatas: [{ metering_usage: [{ value: 0.25 }] }],
          },
        },
        ...over,
      }),
    );
  };

  const cleanup = (sessionId: string) =>
    fs.rmSync(path.join(config.kiroSessionsDir, `${sessionId}.json`), { force: true });

  it('a dormant session reports what kiro’s file says', async () => {
    writeSessionFile('dormant-1');
    linkChat('dormant-1');
    const mgr = new SessionManager(noopLogger());
    try {
      const [summary] = await mgr.listChats();
      assert.equal(summary?.sessionId, 'dormant-1');
      assert.equal(summary?.title, 'kiro title');
      assert.equal(summary?.liveness, 'dormant');
      assert.equal(summary?.running, false);
      assert.equal(summary?.agentId, 'file-agent');
      assert.equal(summary?.modelId, 'file-model');
      assert.equal(summary?.contextUsagePercentage, 42);
    } finally {
      mgr.disposeAll();
      cleanup('dormant-1');
    }
  });

  // The bug this projection removes: the list applied fallbacks from kiro's file
  // and the detail did not, so the same session read two ways disagreed.
  it('list and detail agree for a live session', async () => {
    writeSessionFile('agreeing-1');
    const mgr = new SessionManager(noopLogger(), {
      spawn: () => fakeKiroProcess({ sessionId: 'agreeing-1' }),
    });
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'agreeing-1' });
      const fromList = (await mgr.listChats()).find((s) => s.chatId === 'agreeing-1');
      const fromDetail = (await mgr.getDetail('agreeing-1')).summary;

      assert.deepEqual(fromDetail, fromList, 'the two read paths must project identically');
      // createdAt comes from kiro's file, not from when the process started.
      assert.equal(fromDetail.createdAt, '2026-01-01T00:00:00.000Z');
      // A live session with no turn yet still reports the file's value.
      assert.equal(fromDetail.contextUsagePercentage, 42);
      assert.equal(fromDetail.liveness, 'live');
    } finally {
      mgr.disposeAll();
      cleanup('agreeing-1');
    }
  });

  // The panel is a list of chats, so a session in kiro's directory that Casper did not start -
  // a subagent, or a kiro-cli session - has no row and must not appear.
  it('lists only sessions Casper started', async () => {
    writeSessionFile('mine-1');
    linkChat('mine-1');
    writeSessionFile('a-subagent');
    writeSessionFile('someone-elses-kiro-cli-session');

    const mgr = new SessionManager(noopLogger());
    try {
      const listed = (await mgr.listChats()).map((c) => c.chatId);
      assert.deepEqual(listed, ['mine-1']);
    } finally {
      mgr.disposeAll();
      for (const id of ['mine-1', 'a-subagent', 'someone-elses-kiro-cli-session']) cleanup(id);
    }
  });

  it('a Casper override wins over the file, on both read paths', async () => {
    writeSessionFile('override-1');
    linkChat('override-1');
    const mgr = new SessionManager(noopLogger());
    const moved = path.join(sessionsCwd, 'elsewhere');
    fs.mkdirSync(moved, { recursive: true });
    try {
      mgr.renameChat('override-1', 'my name');
      await mgr.setChatCwd('override-1', moved);

      const fromList = (await mgr.listChats()).find((s) => s.chatId === 'override-1');
      const fromDetail = (await mgr.getDetail('override-1')).summary;
      assert.equal(fromList?.title, 'my name');
      assert.equal(fromList?.cwd, moved);
      assert.equal(fromDetail.title, 'my name');
      assert.equal(fromDetail.cwd, moved);
    } finally {
      mgr.disposeAll();
      cleanup('override-1');
    }
  });

  it('the later of kiro’s timestamp and our own activity wins', async () => {
    // kiro's file says the 2nd; a live event now is later, so the list must not
    // report a time older than the session's real last activity.
    writeSessionFile('newer-1');
    const mgr = new SessionManager(noopLogger(), {
      spawn: () => fakeKiroProcess({ sessionId: 'newer-1' }),
    });
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'newer-1' });
      const s = await mgr.ensureOpen('newer-1');
      s.record({ kind: 'turn_ended', stopReason: 'end_turn' });
      const summary = (await mgr.listChats()).find((x) => x.chatId === 'newer-1');
      assert.ok(
        (summary?.updatedAt ?? '') > '2026-01-02T00:00:00.000Z',
        `expected live activity to win, got ${summary?.updatedAt}`,
      );
    } finally {
      mgr.disposeAll();
      cleanup('newer-1');
    }
  });

  it('a session kiro deleted out from under us stops being listed', async () => {
    const mgr = new SessionManager(noopLogger(), {
      spawn: () => fakeKiroProcess({ sessionId: 'ghost-1' }),
    });
    try {
      await mgr.createChat({ cwd: sessionsCwd, chatId: 'ghost-1' });
      const s = await mgr.ensureOpen('ghost-1');
      // Live, no file: legitimate for a brand-new session, so it still lists.
      assert.equal((await mgr.listChats()).length, 1);
      // Once its process is gone and it has no file, it is a ghost.
      s.proc = undefined;
      assert.deepEqual(await mgr.listChats(), []);
    } finally {
      mgr.disposeAll();
    }
  });
});
