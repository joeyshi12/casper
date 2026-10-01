// Run with: npm test

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { SubagentDetailResponse, SubagentListResponse } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import { SessionManager } from '../server/src/session/SessionManager.js';
import { SubagentTracker } from '../server/src/session/SubagentTracker.js';
import { registerSubagentRoutes } from '../server/src/routes/subagents.js';
import { noopLogger, fakeKiroProcess, type FakeProcess } from './helpers.js';

// Fixtures go in temp directories, never the developer's real ~/.kiro. Set before any
// suite runs; node's test runner gives each file its own process, so this cannot leak
// into another file's config.
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-kiro-sessions-subagents-'));
const sessionsCwd = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'casper-subagents-cwd-')),
);
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-data-subagents-'));
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(sessionsCwd, { recursive: true, force: true });
});

// A session/update carrying a subagent's own tool_call, same shape kiro sends.
const childToolCall = (sessionId: string, toolCallId: string, title: string) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title } },
});

// The subagent tool call on the parent, as kiro tags it with _meta.kiro.toolName.
const subagentCall = (
  parentSessionId: string,
  toolCallId: string,
  stages: { name: string; depends_on?: string[] }[],
) => ({
  method: 'session/update',
  params: {
    sessionId: parentSessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Spawning agent crew',
      rawInput: { task: 'test', mode: 'blocking', stages },
      _meta: { kiro: { toolName: 'subagent' } },
    },
  },
});

const subagentCallFinished = (parentSessionId: string, toolCallId: string) => ({
  method: 'session/update',
  params: {
    sessionId: parentSessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
  },
});

const listUpdate = (
  subagents: { sessionId: string; sessionName: string; status: 'working' | 'terminated' }[],
) => ({
  method: '_kiro.dev/subagent/list_update',
  params: {
    subagents: subagents.map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      status: { type: s.status, message: s.status === 'working' ? 'Running' : undefined },
      dependsOn: [],
      createdAtMs: Date.now(),
    })),
    pendingStages: [],
  },
});

describe('SessionManager.wire: notifications are routed by sessionId', () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let chatId: string;
  let parentSessionId: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'parent-routing-test' });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    parentSessionId = detail.summary.sessionId!;
  });
  after(() => mgr.disposeAll());

  it('a notification for the parent session is recorded', async () => {
    const store = mgr.getStore(chatId)!;
    const before = store.head();
    proc.bus.emit('notification', childToolCall(parentSessionId, 'parent-call-1', 'parent tool'));
    assert.equal(store.head(), before + 1);
  });

  it('a notification for a different sessionId is not recorded in the parent store', async () => {
    const store = mgr.getStore(chatId)!;
    const before = store.head();
    proc.bus.emit('notification', childToolCall('some-child-session', 'child-call-1', 'child tool'));
    assert.equal(store.head(), before, 'a child notification must not land in the parent event log');
  });

  it('a notification with no sessionId at all is still recorded (unchanged behaviour)', async () => {
    const store = mgr.getStore(chatId)!;
    const before = store.head();
    proc.bus.emit('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
    });
    assert.equal(store.head(), before + 1);
  });
});

describe('SessionManager.wire: subagent list_update updates the tracker and is pushed as an event', () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let chatId: string;
  let parentSessionId: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'parent-tracker-test' });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    parentSessionId = detail.summary.sessionId!;
  });
  after(() => mgr.disposeAll());

  it('a list_update with no sessionId still updates this chat (one kiro-cli child per chat)', async () => {
    proc.bus.emit(
      'notification',
      subagentCall(parentSessionId, 'subagent-call-1', [{ name: 'stage_one' }, { name: 'stage_two' }]),
    );
    proc.bus.emit(
      'notification',
      listUpdate([{ sessionId: 'child-1', sessionName: 'stage_one', status: 'working' }]),
    );
    const subs = await mgr.getSubagents(chatId);
    const stageOne = subs.find((s) => s.sessionId === 'child-1');
    assert.equal(stageOne?.status, 'working');
    assert.equal(stageOne?.toolCallId, 'subagent-call-1');
  });

  it('a list_update is also recorded as a subagents_changed event, for live push', async () => {
    const store = mgr.getStore(chatId)!;
    const { events } = store.getSince(0);
    const found = events.some((e) => e.payload.kind === 'subagents_changed');
    assert.ok(found, 'expected a subagents_changed event in the store');
  });

  it('a stage not yet started shows up as pending, with what it waits for', async () => {
    proc.bus.emit(
      'notification',
      subagentCall(parentSessionId, 'subagent-call-2', [
        { name: 'alpha' },
        { name: 'beta', depends_on: ['alpha'] },
      ]),
    );
    proc.bus.emit(
      'notification',
      listUpdate([
        { sessionId: 'child-1', sessionName: 'stage_one', status: 'working' },
        { sessionId: 'child-alpha', sessionName: 'alpha', status: 'working' },
      ]),
    );
    const subs = await mgr.getSubagents(chatId);
    const beta = subs.find((s) => s.stageName === 'beta');
    assert.equal(beta?.status, 'pending');
    assert.equal(beta?.activity, 'Waits for alpha');
    // Started subagents list before a pending one, regardless of name order.
    assert.equal(subs.at(-1)?.stageName, 'beta');
  });

  it('finishing the subagent call stops matching its stage names against new children', async () => {
    proc.bus.emit('notification', subagentCallFinished(parentSessionId, 'subagent-call-2'));
    proc.bus.emit(
      'notification',
      listUpdate([
        { sessionId: 'child-1', sessionName: 'stage_one', status: 'working' },
        { sessionId: 'child-alpha', sessionName: 'alpha', status: 'terminated' },
        { sessionId: 'child-beta', sessionName: 'beta', status: 'working' },
      ]),
    );
    const subs = await mgr.getSubagents(chatId);
    const beta = subs.find((s) => s.sessionId === 'child-beta');
    // The call that declared "beta" has finished, so a fresh "beta" (a new, unrelated
    // call reusing the name) resolves to no toolCallId rather than the stale one.
    assert.equal(beta?.toolCallId, undefined);
  });
});

describe('SubagentTracker (unit)', () => {
  it('a started stage resolves its toolCallId from the call that declared it', () => {
    const t = new SubagentTracker();
    t.callStarted('call-1', [{ name: 'a' }, { name: 'b' }]);
    t.apply([{ sessionId: 's1', sessionName: 'a', status: { type: 'working' }, dependsOn: [] }]);
    assert.equal(t.get('s1')?.toolCallId, 'call-1');
  });

  it('a terminated subagent is reported as completed', () => {
    const t = new SubagentTracker();
    t.callStarted('call-1', [{ name: 'a' }]);
    t.apply([{ sessionId: 's1', sessionName: 'a', status: { type: 'working' }, dependsOn: [] }]);
    t.apply([{ sessionId: 's1', sessionName: 'a', status: { type: 'terminated' }, dependsOn: [] }]);
    assert.equal(t.get('s1')?.status, 'completed');
  });

  it('listForCall adds a pending row for a declared stage with no session yet', () => {
    const t = new SubagentTracker();
    t.callStarted('call-1', [{ name: 'a' }, { name: 'b', depends_on: ['a'] }]);
    t.apply([{ sessionId: 's1', sessionName: 'a', status: { type: 'working' }, dependsOn: [] }]);
    const rows = t.listForCall('call-1');
    const pending = rows.find((r) => r.stageName === 'b');
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.activity, 'Waits for a');
  });

  it('a repeated stage name across two calls resolves to whichever call is still open', () => {
    const t = new SubagentTracker();
    t.callStarted('call-1', [{ name: 'fix' }]);
    t.apply([{ sessionId: 's1', sessionName: 'fix', status: { type: 'terminated' }, dependsOn: [] }]);
    t.callFinished('call-1');
    t.callStarted('call-2', [{ name: 'fix' }]);
    t.apply([{ sessionId: 's2', sessionName: 'fix', status: { type: 'working' }, dependsOn: [] }]);
    assert.equal(t.get('s1')?.toolCallId, 'call-1');
    assert.equal(t.get('s2')?.toolCallId, 'call-2');
  });
});

describe('GET /api/chats/:id/subagents and /:subagentId', () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let app: Awaited<ReturnType<typeof Fastify>>;
  let chatId: string;
  let parentSessionId: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'parent-route-test' });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    parentSessionId = detail.summary.sessionId!;

    app = Fastify();
    registerSubagentRoutes(app, mgr);
    await app.ready();

    // A real child session on disk, with its own task text and one recorded turn,
    // so hydrateTranscript has something to read.
    fs.writeFileSync(
      path.join(sessionsDir, 'child-on-disk.json'),
      JSON.stringify({
        session_id: 'child-on-disk',
        title: 'read sprite-dom.ts',
        cwd: sessionsCwd,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:05:00.000Z',
        parent_session_id: parentSessionId,
        session_created_reason: 'subagent',
      }),
    );
    fs.writeFileSync(
      path.join(sessionsDir, 'child-on-disk.jsonl'),
      JSON.stringify({
        version: 'v1',
        kind: 'AssistantMessage',
        data: { message_id: 'm1', content: [{ kind: 'text', data: 'done reading' }] },
      }) + '\n',
    );
  });
  after(async () => {
    await app.close();
    mgr.disposeAll();
    for (const ext of ['json', 'jsonl']) {
      fs.rmSync(path.join(sessionsDir, `child-on-disk.${ext}`), { force: true });
    }
  });

  it('lists the on-disk child session', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/subagents` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SubagentListResponse;
    const child = body.subagents.find((s) => s.sessionId === 'child-on-disk');
    assert.ok(child, 'expected the on-disk child session to be listed');
    assert.equal(child?.status, 'completed');
  });

  it('merges a live tracker row over the on-disk one', async () => {
    proc.bus.emit(
      'notification',
      subagentCall(parentSessionId, 'live-call-1', [{ name: 'reading' }]),
    );
    proc.bus.emit(
      'notification',
      listUpdate([{ sessionId: 'child-on-disk', sessionName: 'reading', status: 'working' }]),
    );
    const res = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/subagents` });
    const body = res.json() as SubagentListResponse;
    const child = body.subagents.find((s) => s.sessionId === 'child-on-disk');
    assert.equal(child?.status, 'working', 'the live row must win over the on-disk default');
    assert.equal(child?.stageName, 'reading');
  });

  it('fetches a subagent transcript hydrated from its own jsonl', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/subagents/child-on-disk`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SubagentDetailResponse;
    assert.equal(body.subagent.sessionId, 'child-on-disk');
    const text = body.transcript.find((it) => it.type === 'message');
    assert.ok(text, 'expected a hydrated message item');
  });

  it('404s for a session id that is not this chat’s child', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/subagents/not-a-child-of-this-chat`,
    });
    assert.equal(res.statusCode, 404);
  });

  it('404s for an unknown chat', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats/no-such-chat/subagents' });
    assert.equal(res.statusCode, 404);
  });
});

describe('a subagent link survives a restart (a fresh SessionManager, same casper.db)', () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let chatId: string;
  let parentSessionId: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'parent-restart-test' });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    parentSessionId = detail.summary.sessionId!;

    // Live link learned the normal way: a subagent call declares its stage, then
    // list_update reports a child session running it.
    proc.bus.emit(
      'notification',
      subagentCall(parentSessionId, 'restart-call-1', [{ name: 'stage_one' }]),
    );
    proc.bus.emit(
      'notification',
      listUpdate([{ sessionId: 'restart-child-1', sessionName: 'stage_one', status: 'terminated' }]),
    );

    // The child's own file, as it would be on disk once kiro finished with it -
    // this is what a restart has to go on, since the tracker above is gone.
    fs.writeFileSync(
      path.join(sessionsDir, 'restart-child-1.json'),
      JSON.stringify({
        session_id: 'restart-child-1',
        title: 'stage_one',
        cwd: sessionsCwd,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:05:00.000Z',
        parent_session_id: parentSessionId,
        session_created_reason: 'subagent',
      }),
    );
  });
  after(() => {
    mgr.disposeAll();
    for (const ext of ['json', 'jsonl']) {
      fs.rmSync(path.join(sessionsDir, `restart-child-1.${ext}`), { force: true });
    }
  });

  it('a second manager, with no live tracker for this chat, still resolves the link', async () => {
    // Nothing adopts parent-restart-test's old process; this stands in for the server
    // having restarted, or the chat's process having been evicted from the pool.
    const freshMgr = new SessionManager(noopLogger(), { spawn: () => fakeKiroProcess() });
    const subs = await freshMgr.getSubagents(chatId);
    const child = subs.find((s) => s.sessionId === 'restart-child-1');
    assert.ok(child, 'expected the on-disk child to be listed');
    assert.equal(child?.toolCallId, 'restart-call-1', 'the tool call id must come from the db, not memory');
    assert.equal(child?.stageName, 'stage_one');
    freshMgr.disposeAll();
  });
});
