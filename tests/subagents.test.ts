import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { CasperEvent, SubagentDetailResponse, SubagentListResponse } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import { SessionManager } from '../server/src/session/SessionManager.js';
import { SubagentTracker } from '../server/src/session/SubagentTracker.js';
import { SubagentLinkStore } from '../server/src/session/subagentLinks.js';
import { registerSubagentRoutes } from '../server/src/routes/subagents.js';
import { noopLogger, fakeKiroProcess, writeV3Session, type FakeProcess } from './helpers.js';

// Fixtures go in temp directories, never the developer's real ~/.kiro. Set before any
// suite runs; node's test runner gives each file its own process, so this cannot leak
// into another file's config.
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-kiro-sessions-subagents-'));
const sessionsCwd = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'casper-subagents-cwd-')),
);
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;
// Where kiro 2.x kept its files, child sessions included.
const v2Dir = path.join(sessionsDir, 'cli');
fs.mkdirSync(v2Dir, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-data-subagents-'));
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(sessionsCwd, { recursive: true, force: true });
});

// A session/update carrying a tool_call, same shape kiro sends.
const childToolCall = (sessionId: string, toolCallId: string, title: string) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title } },
});

// The tool call kiro V3 starts a subagent with, on the parent's session.
const invokeCall = (sessionId: string, toolCallId: string, subagentId: string, name: string) => ({
  method: 'session/update',
  params: {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Sub-agent: ${name}`,
      kind: 'other',
      status: 'pending',
      rawInput: { name, prompt: 'Run ls and report back.', explanation: 'why', contextFiles: [] },
      _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: subagentId } },
    },
  },
});

const invokeEnded = (sessionId: string, toolCallId: string, subagentId: string, status: 'completed' | 'failed') => ({
  method: 'session/update',
  params: {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status,
      rawOutput: 'The answer.',
      _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: subagentId } },
    },
  },
});

// One of the subagent's own updates. kiro sends them on the parent's session, tagged.
const fromSubagent = (sessionId: string, subagentId: string, update: Record<string, unknown>) => ({
  method: 'session/update',
  params: { sessionId, update: { ...update, _meta: { kiro: { agentSubtaskId: subagentId } } } },
});

const kinds = (events: CasperEvent[]) => events.map((e) => e.payload.kind);

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

describe('SessionManager.wire: a kiro V3 subagent', () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let chatId: string;
  let sid: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'parent-v3-wire' });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    sid = detail.summary.sessionId!;
  });
  after(() => mgr.disposeAll());

  it('the call that starts it is a tool call in the chat, and adds a working row', async () => {
    const store = mgr.getStore(chatId)!;
    const head = store.head();
    proc.bus.emit('notification', invokeCall(sid, 'invoke-1', 'sub-1', 'context-gatherer'));
    assert.deepEqual(kinds(store.getSince(head).events), ['subagents_changed', 'session_update']);
    const [row] = await mgr.getSubagents(chatId);
    assert.equal(row?.sessionId, 'sub-1');
    assert.equal(row?.stageName, 'context-gatherer');
    assert.equal(row?.toolCallId, 'invoke-1');
    assert.equal(row?.status, 'working');
  });

  it("keeps the subagent's own updates out of the chat, showing its latest step on the row", async () => {
    const store = mgr.getStore(chatId)!;
    const head = store.head();
    proc.bus.emit(
      'notification',
      fromSubagent(sid, 'sub-1', { sessionUpdate: 'tool_call', toolCallId: 'sub-call-1', title: 'List workspace files', kind: 'execute' }),
    );
    proc.bus.emit(
      'notification',
      fromSubagent(sid, 'sub-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the subagent talking' } }),
    );
    assert.deepEqual(kinds(store.getSince(head).events), ['subagents_changed'], 'only the row changed');
    assert.equal((await mgr.getSubagents(chatId))[0]?.activity, 'List workspace files');
  });

  it('marks the row done when the call that started it ends', async () => {
    proc.bus.emit('notification', invokeEnded(sid, 'invoke-1', 'sub-1', 'completed'));
    const [row] = await mgr.getSubagents(chatId);
    assert.equal(row?.status, 'completed');
    assert.equal(row?.activity, undefined);
  });

  it('a failed call marks its subagent failed', async () => {
    proc.bus.emit('notification', invokeCall(sid, 'invoke-2', 'sub-2', 'general-task-execution'));
    proc.bus.emit('notification', invokeEnded(sid, 'invoke-2', 'sub-2', 'failed'));
    const row = (await mgr.getSubagents(chatId)).find((r) => r.sessionId === 'sub-2');
    assert.equal(row?.status, 'failed');
  });
});

describe('SubagentTracker (unit)', () => {
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

  it('lists subagents in the order they started, as copies', () => {
    const t = new SubagentTracker(tick);
    assert.equal(t.started('s2', 'call-2', 'second'), true);
    assert.equal(t.started('s1', 'call-1', 'first'), true);
    assert.equal(t.started('s1', 'call-1', 'first'), false, 'a repeat changes nothing');
    assert.deepEqual(t.list().map((s) => s.sessionId), ['s2', 's1']);
    t.list()[0]!.status = 'failed';
    assert.equal(t.get('s2')?.status, 'working', 'a listed row is a copy');
  });

  it('reports a change only when the activity moves on', () => {
    const t = new SubagentTracker(tick);
    t.started('s1', 'call-1', 'a');
    assert.equal(t.progressed('s1'), false, 'a chunk with no new step');
    assert.equal(t.progressed('s1', 'Reading x.ts'), true);
    assert.equal(t.progressed('s1', 'Reading x.ts'), false);
    assert.equal(t.progressed('unknown', 'Reading x.ts'), false);
  });

  it('finishes the subagent its call started, and only while it works', () => {
    const t = new SubagentTracker(tick);
    t.started('s1', 'call-1', 'a');
    assert.equal(t.finished('call-9', true), false);
    assert.equal(t.finished('call-1', true), true);
    assert.equal(t.get('s1')?.status, 'completed');
    assert.equal(t.finished('call-1', false), false, 'an ended subagent stays as it ended');
    assert.equal(t.progressed('s1', 'late'), false);
  });

  it('turnEnded marks working subagents stopped', () => {
    const t = new SubagentTracker(tick);
    t.started('s1', 'call-1', 'a');
    t.started('s2', 'call-2', 'b');
    t.finished('call-2', true);
    assert.equal(t.turnEnded(), true);
    assert.equal(t.get('s1')?.status, 'failed');
    assert.equal(t.get('s1')?.activity, 'Stopped');
    assert.equal(t.get('s2')?.status, 'completed', 'a finished subagent keeps its status');
    assert.equal(t.turnEnded(), false, 'nothing left to change');
  });
});

/** The lines kiro V3 writes in the parent's messages.jsonl for one subagent. */
const subagentLines = (toolCallId: string, subId: string, name: string, done?: 'success' | 'error') => [
  {
    id: `${toolCallId}-sub-agent-start`,
    timestamp: '2026-11-07T06:42:55.661Z',
    payload: { type: 'sub_agent_start', subSessionId: subId, subAgentName: name, prompt: 'Run ls and report back.' },
  },
  ...(done
    ? [
        {
          id: `${toolCallId}-sub-agent-complete`,
          timestamp: '2026-11-07T06:43:01.171Z',
          payload: { type: 'sub_agent_complete', subSessionId: subId, response: 'out.txt', status: done },
        },
      ]
    : []),
];

describe('GET /api/chats/:id/subagents and /:subagentId (kiro V3)', () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let app: Awaited<ReturnType<typeof Fastify>>;
  let chatId: string;
  let sid: string;
  let otherChatId: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'sess_parent-route' });
    let n = 0;
    mgr = new SessionManager(noopLogger(), {
      spawn: () => (n++ === 0 ? proc : fakeKiroProcess({ sessionId: 'sess_other-chat' })),
    });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    sid = detail.summary.sessionId!;
    otherChatId = (await mgr.createChat({ cwd: sessionsCwd })).summary.chatId;

    writeV3Session(sessionsDir, {
      id: sid,
      cwd: sessionsCwd,
      messages: [
        { id: 'u1', timestamp: '2026-11-07T06:42:49.000Z', payload: { type: 'user', content: 'go' } },
        ...subagentLines('invoke-done', 'sub-done', 'semantic_reviewer', 'success'),
        ...subagentLines('invoke-running', 'sub-running', 'context-gatherer'),
      ],
      subExecutions: {
        'sub-done': [
          {
            id: 'run_command_1-call',
            timestamp: '2026-11-07T06:42:58.000Z',
            payload: { type: 'tool_call', toolCallId: 'run_command_1', toolName: 'execute_bash', kind: 'execute', title: 'List files', args: { command: 'ls' }, status: 'completed' },
          },
          {
            id: 'run_command_1-result',
            timestamp: '2026-11-07T06:42:58.000Z',
            payload: { type: 'tool_result', toolCallId: 'run_command_1', content: 'Output:\nout.txt', success: true },
          },
          {
            id: 'say-1',
            timestamp: '2026-11-07T06:43:00.000Z',
            payload: { type: 'assistant', operationType: 'Say', content: 'The directory holds out.txt.' },
          },
        ],
      },
    });
    writeV3Session(sessionsDir, {
      id: 'sess_other-chat',
      cwd: sessionsCwd,
      messages: subagentLines('invoke-other', 'sub-other', 'reviewer', 'success'),
      subExecutions: { 'sub-other': [] },
    });

    app = Fastify();
    registerSubagentRoutes(app, mgr);
    await app.ready();
  });
  after(async () => {
    await app.close();
    mgr.disposeAll();
  });

  const list = async () =>
    ((await app.inject({ method: 'GET', url: `/api/chats/${chatId}/subagents` })).json() as SubagentListResponse).subagents;

  it("lists the subagents kiro recorded in the session's file", async () => {
    const rows = await list();
    assert.deepEqual(
      rows.map((r) => [r.sessionId, r.stageName, r.toolCallId, r.status, r.activity]),
      [
        ['sub-done', 'semantic_reviewer', 'invoke-done', 'completed', undefined],
        ['sub-running', 'context-gatherer', 'invoke-running', 'failed', 'Stopped'],
      ],
    );
  });

  it('a live row wins over a recorded one that has not ended', async () => {
    proc.bus.emit('notification', invokeCall(sid, 'invoke-running', 'sub-running', 'context-gatherer'));
    proc.bus.emit('notification', invokeCall(sid, 'invoke-done', 'sub-done', 'semantic_reviewer'));
    const rows = await list();
    assert.equal(rows.find((r) => r.sessionId === 'sub-running')?.status, 'working');
    assert.equal(rows.find((r) => r.sessionId === 'sub-done')?.status, 'completed', 'the file says it ended');
  });

  it("serves a subagent's transcript from its sub-executions file", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/subagents/sub-done` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SubagentDetailResponse;
    assert.equal(body.subagent.stageName, 'semantic_reviewer');
    assert.equal(body.subagent.status, 'completed');
    const tool = body.transcript.find((it) => it.type === 'tool_call');
    assert.ok(tool?.type === 'tool_call');
    assert.deepEqual(tool.tool.input, { command: 'ls' });
    assert.equal(tool.tool.kind, 'execute');
    assert.equal(tool.tool.name, undefined, "kiro V3's built-in tools stay unnamed");
    const last = body.transcript.at(-1);
    assert.ok(last?.type === 'message' && last.message.text === 'The directory holds out.txt.');
  });

  it('serves a live subagent before kiro has written its file', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/subagents/sub-running` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SubagentDetailResponse;
    assert.equal(body.subagent.status, 'working');
    assert.deepEqual(body.transcript, []);
  });

  it("404s for another chat's subagent, and for an id that could leave the directory", async () => {
    for (const id of ['sub-other', '..', '..%2F..%2Fsess_other-chat']) {
      const res = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/subagents/${id}` });
      assert.equal(res.statusCode, 404, id);
    }
    const own = await app.inject({ method: 'GET', url: `/api/chats/${otherChatId}/subagents/sub-other` });
    assert.equal(own.statusCode, 200, 'the other chat can read its own');
  });

  it('404s for an unknown chat', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats/no-such-chat/subagents' });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/chats/:id/subagents/:subagentId (kiro 2.x child sessions)', () => {
  let mgr: SessionManager;
  let app: Awaited<ReturnType<typeof Fastify>>;
  let chatId: string;
  let parentSessionId: string;

  before(async () => {
    mgr = new SessionManager(noopLogger(), { spawn: () => fakeKiroProcess({ sessionId: 'parent-route-test' }) });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    parentSessionId = detail.summary.sessionId!;

    app = Fastify();
    registerSubagentRoutes(app, mgr);
    await app.ready();

    // A child session kiro 2.x wrote, with its own task text and one recorded turn.
    fs.writeFileSync(
      path.join(v2Dir, 'child-on-disk.json'),
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
      path.join(v2Dir, 'child-on-disk.jsonl'),
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
      fs.rmSync(path.join(v2Dir, `child-on-disk.${ext}`), { force: true });
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

    // The link Casper saved while kiro 2.x ran the subagent.
    new SubagentLinkStore().record('restart-child-1', parentSessionId, 'restart-call-1', 'stage_one');

    // The child's own file, as it would be on disk once kiro finished with it -
    // this is what a restart has to go on, since the tracker above is gone.
    fs.writeFileSync(
      path.join(v2Dir, 'restart-child-1.json'),
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
      fs.rmSync(path.join(v2Dir, `restart-child-1.${ext}`), { force: true });
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

describe('a title-matched subagent is saved, so the parent transcript is read once', () => {
  let mgr: SessionManager;
  let chatId: string;
  let parentSessionId: string;

  before(async () => {
    mgr = new SessionManager(noopLogger(), { spawn: () => fakeKiroProcess({ sessionId: 'parent-fallback-test' }) });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    chatId = detail.summary.chatId;
    parentSessionId = detail.summary.sessionId!;
    // The parent's own record of the subagent call: the only place the stage name is.
    fs.writeFileSync(
      path.join(v2Dir, `${parentSessionId}.jsonl`),
      JSON.stringify({
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          message_id: 'p1',
          content: [{ kind: 'toolUse', data: { toolUseId: 'fallback-call-1', name: 'subagent', input: {
            task: 'Port the input layer.',
            stages: [{ name: 'input_layer', prompt_template: '{task}\n\nPort scripts/input.gd.' }],
          } } }],
        },
      }) + '\n',
    );
    fs.writeFileSync(
      path.join(v2Dir, 'fallback-child-1.json'),
      JSON.stringify({
        session_id: 'fallback-child-1',
        title: 'Port the input layer.\n\nPort scripts/input.gd.',
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
    fs.rmSync(path.join(v2Dir, 'fallback-child-1.json'), { force: true });
    fs.rmSync(path.join(v2Dir, `${parentSessionId}.jsonl`), { force: true });
  });

  it('still resolves the child after the parent transcript is gone', async () => {
    const first = (await mgr.getSubagents(chatId)).find((s) => s.sessionId === 'fallback-child-1');
    assert.equal(first?.toolCallId, 'fallback-call-1', 'matched by title the first time');

    fs.rmSync(path.join(v2Dir, `${parentSessionId}.jsonl`), { force: true });
    const fresh = new SessionManager(noopLogger(), { spawn: () => fakeKiroProcess() });
    const again = (await fresh.getSubagents(chatId)).find((s) => s.sessionId === 'fallback-child-1');
    assert.equal(again?.toolCallId, 'fallback-call-1', 'the match came from the db, not a second read');
    assert.equal(again?.stageName, 'input_layer');
    fresh.disposeAll();
  });

  it('serves the transcript of a child without listing every subagent', async () => {
    const res = await mgr.getSubagentDetail(chatId, 'fallback-child-1');
    assert.equal(res.subagent.stageName, 'input_layer');
  });
});

describe('a finished subagent ends when its transcript was last written', () => {
  it('uses the .jsonl mtime, since the .json stops updating early', async () => {
    const proc = fakeKiroProcess({ sessionId: 'parent-mtime-test' });
    const mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const detail = await mgr.createChat({ cwd: sessionsCwd });
    fs.writeFileSync(path.join(v2Dir, 'mtime-child.json'), JSON.stringify({
      session_id: 'mtime-child', title: 't', cwd: sessionsCwd,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:04.000Z',
      parent_session_id: detail.summary.sessionId, session_created_reason: 'subagent',
    }));
    const jsonl = path.join(v2Dir, 'mtime-child.jsonl');
    fs.writeFileSync(jsonl, '');
    const end = new Date('2026-01-01T00:12:00.000Z');
    fs.utimesSync(jsonl, end, end);
    const res = await mgr.getSubagentDetail(detail.summary.chatId, 'mtime-child');
    assert.equal(res.subagent.updatedAt, end.toISOString());
    const listed = (await mgr.getSubagents(detail.summary.chatId)).find((s) => s.sessionId === 'mtime-child');
    assert.equal(listed?.updatedAt, end.toISOString());
    mgr.disposeAll();
    for (const ext of ['json', 'jsonl']) fs.rmSync(path.join(v2Dir, `mtime-child.${ext}`), { force: true });
  });
});
