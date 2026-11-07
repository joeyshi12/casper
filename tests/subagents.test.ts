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

// The tool call kiro starts a subagent with, on the parent's session.
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

describe('SessionManager.wire: a subagent', () => {
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

describe('GET /api/chats/:id/subagents and /:subagentId', () => {
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
