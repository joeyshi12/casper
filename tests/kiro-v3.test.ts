// kiro's session store, and how SessionManager drives a kiro session. The file shapes
// follow what kiro-cli 3.1 wrote.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CasperEvent, StoredTurnEnding, TranscriptItem } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import {
  deletePersistedSession,
  hydrateTranscript,
  isLoadable,
  promptCount,
  readPersistedSession,
  readPersistedSessions,
} from '../server/src/session/kiroFiles.js';
import { SessionManager } from '../server/src/session/SessionManager.js';
import { fakeKiroProcess, noopLogger, waitFor, writeV3Session, type FakeProcess, type V3Line } from './helpers.js';

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-v3-sessions-'));
const sessionsCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-v3-cwd-')));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-v3-data-'));
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  for (const d of [sessionsDir, sessionsCwd, dataDir]) fs.rmSync(d, { recursive: true, force: true });
});

let lineNo = 0;
const line = (payload: Record<string, unknown>, timestamp = '2026-11-07T06:39:09.132Z', id?: string): V3Line => ({
  id: id ?? `line-${lineNo++}`,
  timestamp,
  payload,
});

const texts = (items: TranscriptItem[]) =>
  items.map((it) =>
    it.type === 'message'
      ? `${it.message.role}:${it.message.text}`
      : it.type === 'tool_call'
        ? `tool:${it.tool.name ?? it.tool.kind}:${it.tool.status}`
        : it.type,
  );

describe("reading kiro's session store", () => {
  it('reads the metadata, with no title until kiro names the session', async () => {
    writeV3Session(sessionsDir, { id: 'sess_meta', cwd: sessionsCwd, agentMode: 'casper', modelId: 'claude-haiku-4.5' });
    const s = await readPersistedSession('sess_meta');
    assert.deepEqual(s, {
      sessionId: 'sess_meta',
      title: '',
      cwd: sessionsCwd,
      createdAt: '2026-11-07T06:39:07.031Z',
      updatedAt: '2026-11-07T06:39:15.621Z',
      agentId: 'casper',
      modelId: 'claude-haiku-4.5',
      effortLevel: undefined,
      contextUsagePercentage: undefined,
    });
    writeV3Session(sessionsDir, { id: 'sess_meta', cwd: sessionsCwd, title: 'Run Shell Command and Verify File' });
    assert.equal((await readPersistedSession('sess_meta'))?.title, 'Run Shell Command and Verify File');
  });

  it('reads the latest context usage from the end of the conversation', async () => {
    const usage = (usagePercentage: number) => line({ type: 'session_metadata', key: 'contextUsage', value: { usagePercentage } });
    const big = (n: number) => line({ type: 'user', content: 'x'.repeat(n) });
    const usageOf = async (messages: V3Line[]) => {
      writeV3Session(sessionsDir, { id: 'sess_usage', cwd: sessionsCwd, messages });
      return (await readPersistedSession('sess_usage'))?.contextUsagePercentage;
    };
    assert.equal(await usageOf([usage(2.3662), big(300_000), usage(8.333), line({ type: 'turn_end' })]), 8.333);
    // Behind a line longer than the chunks it is read in.
    assert.equal(await usageOf([usage(1.5), usage(4.25), big(100_000)]), 4.25);
    // As the very first line of the file.
    assert.equal(await usageOf([usage(3.5), big(20_000)]), 3.5);
    // Not past the limit, and not at all in a session that never recorded one.
    assert.equal(await usageOf([usage(9), big(2_000_000)]), undefined);
    assert.equal(await usageOf([line({ type: 'user', content: 'hi' })]), undefined);
  });

  it('finds a session whose chat moved to another directory', async () => {
    // kiro files a session under a hash of the cwd it first saw.
    writeV3Session(sessionsDir, { id: 'sess_moved', cwd: '/somewhere/else' });
    assert.equal((await readPersistedSession('sess_moved'))?.cwd, '/somewhere/else');
  });

  it('hydrates a conversation the way the live stream draws it', async () => {
    writeV3Session(sessionsDir, {
      id: 'sess_hydrate',
      cwd: sessionsCwd,
      messages: [
        line({ type: 'agent_note', content: '<session_context>...</session_context>' }),
        line({ type: 'user', content: 'Run it' }, '2026-11-07T06:39:09.132Z', 'u1'),
        line({ type: 'turn_start' }),
        line({ type: 'assistant', operationType: 'Reasoning', content: '...' }),
        line({ type: 'assistant', operationType: 'Reasoning', content: '\nThinking out loud.\n' }),
        line({ type: 'tool_call', toolCallId: 'sh-1', toolName: 'execute_bash', kind: 'execute', title: 'Print hello', args: { command: 'echo hello' }, status: 'completed' }),
        line({ type: 'tool_result', toolCallId: 'sh-1', content: 'Output:\nhello', success: true }),
        line({
          type: 'tool_call',
          toolCallId: 'mcp-1',
          toolName: 'tool_call',
          kind: 'other',
          title: '@casper/show_choice',
          args: { tool_id: 'casper::show_choice', arguments: { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] } },
          status: 'completed',
          _meta: { kiro: { serverName: 'casper' } },
        }),
        line({ type: 'tool_result', toolCallId: 'mcp-1', content: 'Options are on screen.', success: true }),
        line({ type: 'tool_call', toolCallId: 'rd-1', toolName: 'read_file', kind: 'read', title: 'Read File', args: { path: '/x' }, status: 'approved' }),
        line({ type: 'tool_result', toolCallId: 'rd-1', content: 'nope', success: false }),
        line({ type: 'sub_agent_start', subSessionId: 'sub-1', subAgentName: 'context-gatherer', prompt: 'Look around.' }, undefined, 'invoke-1-sub-agent-start'),
        line({ type: 'sub_agent_complete', subSessionId: 'sub-1', response: 'Found it.', status: 'success' }, undefined, 'invoke-1-sub-agent-complete'),
        line({ type: 'assistant', operationType: 'Say', content: 'Done.' }),
        line({ type: 'turn_end', stopReason: 'end_turn' }),
        line({ type: 'tombstone', kind: 'summarization' }),
        line({ type: 'assistant', operationType: 'Summary', content: '## Overview\nA summary.' }),
        line({ type: 'user', content: [{ type: 'text', text: 'Next' }] }),
        'not json' as unknown as V3Line,
      ],
    });
    const items = await hydrateTranscript('sess_hydrate');
    assert.deepEqual(texts(items), [
      'user:Run it',
      'thinking:Thinking out loud.',
      'tool:execute:completed',
      'tool:casper/show_choice:completed',
      'tool:read:failed',
      'tool:invoke_sub_agent:completed',
      'assistant:Done.',
      'compaction',
      'user:Next',
    ]);
    const tool = (id: string) => items.find((it) => it.type === 'tool_call' && it.tool.id === id);
    const mcp = tool('mcp-1');
    assert.ok(mcp?.type === 'tool_call');
    assert.deepEqual(mcp.tool.input, { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }, 'the MCP arguments, unwrapped');
    const sh = tool('sh-1');
    assert.ok(sh?.type === 'tool_call');
    assert.deepEqual(sh.tool.content, [{ type: 'text', text: 'Output:\nhello' }]);
    const sub = tool('invoke-1');
    assert.ok(sub?.type === 'tool_call', 'named by the live call id, so its subagent rows find it');
    assert.equal((sub.tool.input as { name: string }).name, 'context-gatherer');
    assert.equal(sub.tool.output, 'Found it.');
    assert.equal(await promptCount('sess_hydrate'), 2);
  });

  it("names the tools of a session kiro imported from kiro 2.x by kiro 2.x's names", async () => {
    writeV3Session(sessionsDir, {
      id: 'imported-tools',
      cwd: sessionsCwd,
      messages: [
        line({ type: 'user', content: 'go' }),
        line({ type: 'tool_call', toolCallId: 't1', toolName: 'subagent', args: { stages: [{ name: 'a' }] }, status: 'completed' }),
      ],
    });
    const [, call] = await hydrateTranscript('imported-tools');
    assert.ok(call?.type === 'tool_call');
    assert.equal(call.tool.name, 'subagent');
  });

  it('shows once the turns kiro wrote again after a compaction it copied in from kiro 2.x', async () => {
    writeV3Session(sessionsDir, {
      id: 'imported-compaction',
      cwd: sessionsCwd,
      messages: [
        line({ type: 'user', content: 'first' }, undefined, 'p1'),
        line({ type: 'assistant', operationType: 'Say', content: 'one' }, undefined, 'a1-text-0'),
        line({ type: 'tool_call', toolCallId: 't1', toolName: 'shell', args: { command: 'ls' }, status: 'completed' }, undefined, 'a1-tool-0'),
        line({ type: 'tool_result', toolCallId: 't1', content: 'x', success: true }, undefined, 't1-result'),
        line({ type: 'tombstone', kind: 'summarization' }, undefined, 'tombstone_summarize_s1'),
        line({ type: 'assistant', operationType: 'Summary', content: 'A summary.' }, undefined, 'summary_s1'),
        // What kiro 2.x kept in context past the summary, written again.
        line({ type: 'user', content: 'first' }, undefined, 'compact_s1_p1'),
        line({ type: 'assistant', operationType: 'Say', content: 'one' }, undefined, 'compact_s1_a1-text-0'),
        line({ type: 'tool_call', toolCallId: 't1', toolName: 'shell', args: { command: 'ls' }, status: 'completed' }, undefined, 'compact_s1_a1-tool-0'),
        line({ type: 'tool_result', toolCallId: 't1', content: 'x', success: true }, undefined, 'compact_s1_t1-result'),
        line({ type: 'user', content: 'after' }, undefined, 'p2'),
        // An id of that shape that repeats nothing is kept.
        line({ type: 'user', content: 'unmatched' }, undefined, 'compact_s1_never-seen'),
      ],
    });
    assert.deepEqual(texts(await hydrateTranscript('imported-compaction')), [
      'user:first',
      'assistant:one',
      'tool:shell:completed',
      'compaction',
      'user:after',
      'user:unmatched',
    ]);
    assert.equal(await promptCount('imported-compaction'), 3, 'attachments stay on the prompts they were sent with');
  });

  it('puts attachments and stored turn endings back, with millisecond timestamps', async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 6, 0, s)).toISOString();
    writeV3Session(sessionsDir, {
      id: 'sess_merge',
      cwd: sessionsCwd,
      messages: [
        line({ type: 'user', content: 'first' }, at(0)),
        line({ type: 'assistant', operationType: 'Say', content: 'ok' }, at(1)),
        line({ type: 'user', content: 'second' }, at(10)),
        line({ type: 'assistant', operationType: 'Say', content: 'what kiro kept' }, at(11)),
      ],
    });
    const ending: StoredTurnEnding = {
      id: 7,
      startedAt: Date.parse(at(10)) - 5,
      endedAt: Date.parse(at(12)),
      prompt: 'second',
      kind: 'interrupted',
      items: [{ type: 'message', message: { id: 'a', role: 'assistant', text: 'what the turn showed' } }],
    };
    const file = { path: '/tmp/x.png', name: 'x.png', size: 1, kind: 'image' as const };
    const items = await hydrateTranscript('sess_merge', new Map([[1, [file]]]), [ending]);
    assert.deepEqual(texts(items), ['user:first', 'assistant:ok', 'user:second', 'assistant:what the turn showed', 'turn_interrupted']);
    const second = items[2];
    assert.ok(second?.type === 'message');
    assert.deepEqual(second.message.attachments, [file]);
  });

  it('can load any session kiro stored, even one never prompted', async () => {
    writeV3Session(sessionsDir, { id: 'sess_empty', cwd: sessionsCwd });
    assert.equal(await isLoadable('sess_empty'), true, 'kiro keeps an empty session');
    assert.equal(await isLoadable('no-such-session'), false);
    assert.equal(await isLoadable('../escape'), false);
  });

  it("deletes a session's directory", async () => {
    const dir = writeV3Session(sessionsDir, { id: 'to-delete', cwd: sessionsCwd, messages: [] });
    await deletePersistedSession('to-delete');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(await readPersistedSession('to-delete'), null);
  });

  it("does not read kiro 2.x's old store as a workspace", async () => {
    // kiro 3.x leaves kiro 2.x's files in cli/, which has directories named by session id.
    for (const id of ['sess_meta', 'only-in-cli']) {
      fs.mkdirSync(path.join(sessionsDir, 'cli', id, 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'cli', id, 'session.json'), `{"id":"${id}","title":"stale"}`);
    }
    assert.equal(await readPersistedSession('only-in-cli'), null);
    assert.equal((await readPersistedSessions(['only-in-cli'])).size, 0);
    assert.notEqual((await readPersistedSession('sess_meta'))?.title, 'stale');
    assert.ok((await readPersistedSessions(['sess_meta'])).get('sess_meta')?.cwd, 'the real copy is found');
  });
});

/** A manager on one fake process, with the chat it created. */
const managerWith = async (proc: FakeProcess, opts: { defaultModel?: string; modelId?: string } = {}) => {
  const mgr = new SessionManager(noopLogger(), { spawn: () => proc, defaultModel: async () => opts.defaultModel });
  const detail = await mgr.createChat({ cwd: sessionsCwd, modelId: opts.modelId });
  return { mgr, chatId: detail.summary.chatId, sid: detail.summary.sessionId!, detail };
};

const info = (sessionId: string, kiro: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'session_info_update', ...extra, _meta: { kiro } } },
});

const recorded = (events: CasperEvent[]) => events.map((e) => e.payload);

describe('SessionManager: starting a kiro session', () => {
  it('passes the agent and model as session inputs, and adopts the model kiro reports', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_inputs', modelId: 'claude-opus-5.5' });
    const { mgr, detail } = await managerWith(proc, { defaultModel: 'claude-opus-5.5' });
    try {
      assert.deepEqual(proc.args[proc.calls.indexOf('newSession')], [
        { cwd: sessionsCwd, mcpServers: [], _meta: { kiro: { modeId: 'casper', modelId: 'claude-opus-5.5', effortLevel: undefined } } },
      ]);
      assert.equal(detail.summary.modelId, 'claude-opus-5.5');
    } finally {
      mgr.disposeAll();
    }
  });

  it('a model picked for the chat wins over the default', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_picked' });
    const { mgr } = await managerWith(proc, { defaultModel: 'claude-opus-5.5', modelId: 'claude-haiku-4.5' });
    try {
      const [params] = proc.args[proc.calls.indexOf('newSession')] as [{ _meta: { kiro: { modelId: string } } }];
      assert.equal(params._meta.kiro.modelId, 'claude-haiku-4.5');
    } finally {
      mgr.disposeAll();
    }
  });

});

describe("SessionManager: kiro's session updates", () => {
  let mgr: SessionManager;
  let proc: FakeProcess;
  let chatId: string;
  let sid: string;

  before(async () => {
    proc = fakeKiroProcess({ sessionId: 'sess_updates' });
    ({ mgr, chatId, sid } = await managerWith(proc));
  });
  after(() => mgr.disposeAll());

  const since = (head: number) => recorded(mgr.getStore(chatId)!.getSince(head).events);

  it('records context usage', async () => {
    const head = mgr.getStore(chatId)!.head();
    proc.bus.emit('notification', info(sid, { kind: 'context_usage', usagePercentage: 12.5, contextUsage: { usagePercentage: 12.5 } }));
    assert.deepEqual(since(head), [{ kind: 'metadata', params: { sessionId: sid, contextUsagePercentage: 12.5 } }]);
    assert.equal((await mgr.ensureOpen(chatId)).turnState.get().contextUsagePercentage, 12.5);
  });

  it('records a compaction kiro starts on its own, with its summary', async () => {
    const head = mgr.getStore(chatId)!.head();
    proc.bus.emit('notification', info(sid, { kind: 'summarization_started' }));
    assert.equal((await mgr.ensureOpen(chatId)).turnState.get().compacting, true);
    proc.bus.emit('notification', info(sid, { kind: 'summarization_completed', conversationSummary: '## Overview' }));
    assert.deepEqual(
      since(head).map((p) => (p.kind === 'compaction' ? [p.params.status.type, p.params.summary] : p.kind)),
      [['started', null], ['completed', '## Overview']],
    );
    assert.equal((await mgr.ensureOpen(chatId)).turnState.get().compacting, false);
  });

  it("drops what the transcript does not show: kiro's other events, replays and extensions", async () => {
    const head = mgr.getStore(chatId)!.head();
    for (const kind of ['focus_update', 'turn_start', 'turn_end', 'turn_completion', 'pending_interaction', 'session_usage']) {
      proc.bus.emit('notification', info(sid, { kind }, { title: 'x' }));
    }
    for (const sessionUpdate of ['available_commands_update', 'config_option_update', 'current_mode_update', 'user_message_chunk']) {
      proc.bus.emit('notification', { method: 'session/update', params: { sessionId: sid, update: { sessionUpdate } } });
    }
    proc.bus.emit('notification', {
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' }, _meta: { kiro: { replay: true } } } },
    });
    for (const method of ['_kiro/mcp/status', '_kiro/sessions/changed', '_kiro/tools/didChange', '_kiro/customAgent/not_found']) {
      proc.bus.emit('notification', { method, params: { sessionId: sid } });
    }
    assert.deepEqual(since(head), []);
  });

  it('records what the transcript is built from', async () => {
    const head = mgr.getStore(chatId)!.head();
    proc.bus.emit('notification', {
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
    });
    assert.deepEqual(since(head).map((p) => p.kind), ['session_update']);
  });
});

describe('SessionManager: compaction', () => {
  it('reports it started, then completed with the summary kiro sends', async () => {
    let finish!: () => void;
    const proc = fakeKiroProcess({ sessionId: 'sess_compact', onCompact: () => new Promise<void>((r) => (finish = r)) });
    const { mgr, chatId, sid } = await managerWith(proc);
    try {
      const store = mgr.getStore(chatId)!;
      const head = store.head();
      await mgr.execCommand(chatId, 'compact');
      assert.deepEqual(proc.args[proc.calls.indexOf('compact')], [sid]);
      const s = await mgr.ensureOpen(chatId);
      assert.equal(s.turnState.get().compacting, true, 'kiro does not report the start of one it was asked for');
      await assert.rejects(() => mgr.execCommand(chatId, 'compact'), /already being compacted/);
      proc.bus.emit('notification', info(sid, { kind: 'summarization_completed', conversationSummary: 'S' }));
      finish();
      await waitFor('kiro to answer', () => !s.turnState.get().compacting);
      await new Promise((r) => setImmediate(r));
      const statuses = recorded(store.getSince(head).events).map((p) => (p.kind === 'compaction' ? p.params.status.type : p.kind));
      assert.deepEqual(statuses, ['started', 'completed'], 'one completion, not two');
    } finally {
      mgr.disposeAll();
    }
  });

  it('reports a failure when kiro refuses', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_compact_fail', onCompact: () => Promise.reject(new Error('no')) });
    const { mgr, chatId } = await managerWith(proc);
    try {
      await mgr.execCommand(chatId, 'compact');
      const s = await mgr.ensureOpen(chatId);
      await waitFor('the failure', () => !s.turnState.get().compacting);
      const last = s.store.getSince(0).events.at(-1)?.payload;
      assert.ok(last?.kind === 'compaction' && last.params.status.type === 'failed');
    } finally {
      mgr.disposeAll();
    }
  });

  it('runs no other command', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_other_cmd' });
    const { mgr, chatId } = await managerWith(proc);
    try {
      await assert.rejects(() => mgr.execCommand(chatId, 'clear'), /Unsupported command/);
      assert.equal(proc.calls.includes('compact'), false);
    } finally {
      mgr.disposeAll();
    }
  });
});

describe('SessionManager: a dormant session', () => {
  it('lists and opens from the V3 file', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_dormant' });
    const { mgr, chatId } = await managerWith(proc);
    mgr.renameChat(chatId, ''); // drop the folder name Casper gave it, so kiro's title shows
    writeV3Session(sessionsDir, {
      id: 'sess_dormant',
      cwd: sessionsCwd,
      title: 'Delegate Shell Command',
      agentMode: 'casper',
      lastModifiedAt: '2030-01-01T00:00:00.000Z',
      messages: [
        line({ type: 'user', content: 'go' }),
        line({ type: 'assistant', operationType: 'Say', content: 'went' }),
        line({ type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 4.5 } }),
      ],
    });
    mgr.disposeAll();
    const fresh = new SessionManager(noopLogger(), { spawn: () => fakeKiroProcess() });
    try {
      const row = (await fresh.listChats()).find((c) => c.chatId === chatId);
      assert.equal(row?.title, 'Delegate Shell Command');
      assert.equal(row?.liveness, 'dormant');
      const detail = await fresh.getDetail(chatId);
      assert.deepEqual(texts(detail.transcript), ['user:go', 'assistant:went']);
      assert.equal(detail.observability.contextUsagePercentage, 4.5);
      assert.equal(detail.currentModeId, 'casper');
    } finally {
      fresh.disposeAll();
    }
  });
});
