// A turn that failed or was stopped is stored by Casper, since kiro keeps none of what it
// had in flight, and put back in the transcript after a reload.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CasperEvent, CasperEventPayload, StoredTurnEnding, TranscriptItem } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import { ChatStore } from '../server/src/session/chatStore.js';
import { hydrateTranscript } from '../server/src/session/kiroFiles.js';
import { SessionManager } from '../server/src/session/SessionManager.js';
import { TurnRecorder } from '../server/src/session/TurnRecorder.js';
import { fakeKiroProcess, noopLogger, type FakeProcess } from './helpers.js';

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-endings-sessions-'));
const sessionsCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-endings-cwd-')));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-endings-data-'));
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;
(config as { casperDataDir: string }).casperDataDir = dataDir;

after(() => {
  closeDb();
  for (const d of [sessionsDir, sessionsCwd, dataDir]) fs.rmSync(d, { recursive: true, force: true });
});

const event = (seq: number, ts: number, payload: unknown): CasperEvent => ({
  seq,
  ts,
  chatId: 'c1',
  payload: payload as CasperEventPayload,
});
const update = (seq: number, ts: number, u: Record<string, unknown>) =>
  event(seq, ts, { kind: 'session_update', update: u });

describe('TurnRecorder', () => {
  const startTurn = (r: TurnRecorder) =>
    r.observe(event(1, 1000, { kind: 'turn_started', prompt: [{ type: 'text', text: 'run it' }] }));

  it('rebuilds what the turn showed, in order, ending with the text still streaming', () => {
    const r = new TurnRecorder();
    startTurn(r);
    r.observe(update(2, 1100, { sessionUpdate: 'agent_message_chunk', content: { text: 'Starting. ' } }));
    r.observe(update(3, 1200, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'shell', rawInput: { command: 'ls' } }));
    r.observe(update(4, 1300, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
    r.observe(update(5, 1400, { sessionUpdate: 'agent_message_chunk', content: { text: 'Half a sent' } }));
    const ending = r.finish({ kind: 'failed', message: 'kiro-cli exited' }, 2000)!;

    assert.equal(ending.prompt, 'run it');
    assert.equal(ending.startedAt, 1000);
    assert.equal(ending.endedAt, 2000);
    assert.deepEqual(
      ending.items.map((i) => (i.type === 'message' ? i.message.text : i.type === 'tool_call' ? `tool:${i.tool.status}` : i.type)),
      ['Starting. ', 'tool:completed', 'Half a sent'],
    );
  });

  it('strips the attachments line from the prompt', () => {
    const r = new TurnRecorder();
    r.observe(
      event(1, 1000, {
        kind: 'turn_started',
        prompt: [{ type: 'text', text: 'Attached files: /a/b.png\n' }, { type: 'text', text: 'look at this' }],
      }),
    );
    assert.equal(r.finish({ kind: 'interrupted' })!.prompt, 'look at this');
  });

  it('drops image blocks and cuts very long output', () => {
    const r = new TurnRecorder();
    startTurn(r);
    r.observe(update(2, 1100, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read' }));
    r.observe(
      update(3, 1200, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'x'.repeat(50_000) } },
          { type: 'content', content: { type: 'image', data: 'AAAA' } },
        ],
      }),
    );
    const tool = r.finish({ kind: 'interrupted' })!.items.find((i) => i.type === 'tool_call');
    assert.ok(tool && tool.type === 'tool_call');
    assert.equal(tool.tool.content.length, 1, 'the image block is gone');
    const text = (tool.tool.content[0] as { content: { text: string } }).content.text;
    assert.ok(text.length < 25_000 && text.endsWith('[truncated]'));
  });

  it('marks a tool that never reported back as failed', () => {
    const r = new TurnRecorder();
    startTurn(r);
    r.observe(update(2, 1100, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'shell', status: 'in_progress' }));
    const tool = r.finish({ kind: 'interrupted' })!.items.find((i) => i.type === 'tool_call');
    assert.ok(tool && tool.type === 'tool_call' && tool.tool.status === 'failed');
  });

  it('has nothing to give for a turn that was discarded or never started', () => {
    const r = new TurnRecorder();
    assert.equal(r.finish({ kind: 'interrupted' }), null);
    startTurn(r);
    r.discard();
    assert.equal(r.finish({ kind: 'interrupted' }), null);
  });
});

describe('hydrateTranscript with stored turn endings', () => {
  const sid = 'endings-hydrate';
  const file = path.join(sessionsDir, `${sid}.jsonl`);
  const T = 1_800_000_000; // seconds, as kiro stamps a record

  const prompt = (id: string, text: string, ts: number) => ({
    kind: 'Prompt',
    data: { message_id: id, content: [{ kind: 'text', data: text }], meta: { timestamp: ts } },
  });
  const assistant = (id: string, text: string, ts: number) => ({
    kind: 'AssistantMessage',
    data: { message_id: id, content: [{ kind: 'text', data: text }], meta: { timestamp: ts } },
  });
  const write = (...lines: unknown[]) =>
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const msg = (id: string, role: 'assistant' | 'thinking', text: string): TranscriptItem => ({
    type: 'message',
    message: { id, role, text },
  });
  const ending = (over: Partial<StoredTurnEnding>): StoredTurnEnding => ({
    id: 1,
    startedAt: T * 1000,
    endedAt: T * 1000 + 8000,
    prompt: 'do it',
    kind: 'failed',
    message: 'kiro-cli exited on SIGTERM',
    items: [],
    ...over,
  });
  const shape = (items: TranscriptItem[]) =>
    items.map((i) =>
      i.type === 'message' ? `${i.message.role}:${i.message.text}` : i.type === 'turn_error' ? `error:${i.message}` : i.type,
    );

  after(() => fs.rmSync(file, { force: true }));
  beforeEach(() => fs.rmSync(file, { force: true }));

  it('replaces what kiro kept of a failed turn with the stored turn and its error', async () => {
    write(prompt('p1', 'do it', T + 1), assistant('a1', 'Starting.', T + 3));
    const items = await hydrateTranscript(sid, undefined, [
      ending({ items: [msg('s-2', 'assistant', 'Starting.'), msg('s-9', 'assistant', 'And then more')] }),
    ]);
    assert.deepEqual(shape(items), [
      'user:do it',
      'assistant:Starting.',
      'assistant:And then more',
      'error:kiro-cli exited on SIGTERM',
    ]);
  });

  it('matches a prompt kiro wrote some seconds into a long turn', async () => {
    write(prompt('p1', 'do it', T + 6), assistant('a1', 'Starting.', T + 8));
    const items = await hydrateTranscript(sid, undefined, [
      ending({ endedAt: T * 1000 + 30_000, items: [msg('s-2', 'assistant', 'Starting.')] }),
    ]);
    assert.deepEqual(shape(items), ['user:do it', 'assistant:Starting.', 'error:kiro-cli exited on SIGTERM']);
  });

  it('replaces the one-line note kiro writes for a stopped turn', async () => {
    write(prompt('p1', 'do it', T + 1), assistant('a1', 'Response was interrupted by the user', T + 9));
    const items = await hydrateTranscript(sid, undefined, [
      ending({ kind: 'interrupted', message: undefined, items: [msg('s-2', 'assistant', 'Looking now')] }),
    ]);
    assert.deepEqual(shape(items), ['user:do it', 'assistant:Looking now', 'turn_interrupted']);
  });

  // What kiro 2.19 writes when a turn is stopped during a tool call: the text before it, the
  // call, an errored result and a note. Only the text streamed after the call is missing.
  it('replaces the records kiro writes for a turn stopped during a tool call', async () => {
    const toolUse = { kind: 'toolUse', data: { toolUseId: 'tu1', name: 'shell', input: { command: 'sleep 45' } } };
    write(
      prompt('p1', 'do it', T + 1),
      {
        kind: 'AssistantMessage',
        data: {
          message_id: 'a1',
          content: [{ kind: 'text', data: "I'm about to wait." }, toolUse],
          meta: { timestamp: T + 3 },
        },
      },
      {
        kind: 'ToolResults',
        data: {
          message_id: 'r1',
          content: [{ kind: 'toolResult', data: { toolUseId: 'tu1', status: 'error', content: [] } }],
        },
      },
      assistant('a2', 'Tool uses were interrupted, waiting for the next user prompt', T + 9),
    );
    const tool: TranscriptItem = {
      type: 'tool_call',
      tool: { id: 'tu1', title: 'Running: sleep 45', status: 'in_progress', content: [] },
    };
    const items = await hydrateTranscript(sid, undefined, [
      ending({
        kind: 'interrupted',
        message: undefined,
        items: [msg('s-2', 'assistant', "I'm about to wait."), tool, msg('s-5', 'assistant', 'Still waiting')],
      }),
    ]);
    assert.deepEqual(shape(items), [
      'user:do it',
      "assistant:I'm about to wait.",
      'tool_call',
      'assistant:Still waiting',
      'turn_interrupted',
    ]);
  });

  it('places a turn kiro never recorded between the prompts around it', async () => {
    write(
      prompt('p1', 'first', T - 100),
      assistant('a1', 'one', T - 99),
      prompt('p3', 'third', T + 500),
      assistant('a3', 'three', T + 501),
    );
    const items = await hydrateTranscript(sid, undefined, [
      ending({ prompt: 'second', items: [msg('s-2', 'assistant', 'two, then it died')] }),
    ]);
    assert.deepEqual(shape(items), [
      'user:first',
      'assistant:one',
      'user:second',
      'assistant:two, then it died',
      'error:kiro-cli exited on SIGTERM',
      'user:third',
      'assistant:three',
    ]);
  });

  it('puts an unrecorded turn after the last prompt', async () => {
    write(prompt('p1', 'first', T - 100), assistant('a1', 'one', T - 99));
    const items = await hydrateTranscript(sid, undefined, [ending({ prompt: 'second' })]);
    assert.deepEqual(shape(items), ['user:first', 'assistant:one', 'user:second', 'error:kiro-cli exited on SIGTERM']);
  });

  it('does not take a later retry of the same text for the failed turn', async () => {
    write(prompt('p2', 'do it', T + 60), assistant('a2', 'Done.', T + 62));
    const items = await hydrateTranscript(sid, undefined, [ending({})]);
    assert.deepEqual(shape(items), [
      'user:do it',
      'error:kiro-cli exited on SIGTERM',
      'user:do it',
      'assistant:Done.',
    ]);
  });

  it('gives every item an id of its own when two stored turns reuse event numbers', async () => {
    write();
    const items = await hydrateTranscript(sid, undefined, [
      ending({ id: 1, startedAt: 1000, endedAt: 1500, prompt: 'a', items: [msg('a-s-2', 'assistant', 'x')] }),
      ending({ id: 2, startedAt: 2000, endedAt: 2500, prompt: 'b', items: [msg('a-s-2', 'assistant', 'y')] }),
    ]);
    const ids = items.map((i) => (i.type === 'message' ? i.message.id : i.id));
    assert.equal(new Set(ids).size, ids.length, ids.join(','));
  });

  it('is unchanged when nothing is stored', async () => {
    write(prompt('p1', 'do it', T + 1), assistant('a1', 'Starting.', T + 3));
    assert.deepEqual(shape(await hydrateTranscript(sid)), ['user:do it', 'assistant:Starting.']);
  });
});

describe('a turn that ends badly, through SessionManager', () => {
  let proc: FakeProcess;
  let mgr: SessionManager;
  let outcome: () => Promise<{ stopReason: string }>;

  const emit = (u: Record<string, unknown>) =>
    proc.bus.emit('notification', { method: 'session/update', params: { update: u } });

  const settled = async (chatId: string) => {
    const s = await mgr.ensureOpen(chatId);
    const deadline = Date.now() + 2000;
    while (s.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.running, false, 'the turn should have ended');
  };

  const start = async (chatId: string, text = 'do the thing') => {
    await mgr.createChat({ cwd: sessionsCwd, chatId });
    await mgr.runPrompt(chatId, [{ type: 'text', text }]);
    await settled(chatId);
  };

  beforeEach(() => {
    // The file kiro keeps for a session, so a manager that has never seen it can open the chat.
    fs.writeFileSync(
      path.join(sessionsDir, 'endings-live.json'),
      JSON.stringify({
        session_id: 'endings-live',
        title: 'kiro title',
        cwd: sessionsCwd,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      }),
    );
    proc = fakeKiroProcess({
      sessionId: 'endings-live',
      onPrompt: async () => {
        emit({ sessionUpdate: 'agent_message_chunk', content: { text: 'Working on it. ' } });
        emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'shell', rawInput: { command: 'ls' } });
        emit({ sessionUpdate: 'agent_message_chunk', content: { text: 'Almost' } });
        return outcome() as never;
      },
    });
    mgr = new SessionManager(noopLogger(), { spawn: () => proc });
  });

  const kinds = (items: TranscriptItem[]) => items.map((i) => i.type);

  it('a failed turn is back in the transcript after a restart, with its error', async () => {
    outcome = async () => {
      throw new Error('kiro-cli exited on SIGTERM');
    };
    await start('endings-failed');
    mgr.disposeAll();

    // A new manager and a new store: nothing is left in memory.
    const fresh = new SessionManager(noopLogger(), { spawn: () => proc });
    try {
      const { transcript } = await fresh.getDetail('endings-failed');
      assert.deepEqual(kinds(transcript), ['message', 'message', 'tool_call', 'message', 'turn_error']);
      const texts = transcript.flatMap((i) => (i.type === 'message' ? [i.message.text] : []));
      assert.deepEqual(texts, ['do the thing', 'Working on it. ', 'Almost']);
      const err = transcript.at(-1)!;
      assert.ok(err.type === 'turn_error' && err.message.includes('kiro-cli exited on SIGTERM'));
    } finally {
      fresh.disposeAll();
    }
  });

  it('a stopped turn is back as an interruption', async () => {
    outcome = async () => ({ stopReason: 'cancelled' });
    await start('endings-stopped');
    const { transcript } = await mgr.getDetail('endings-stopped');
    assert.deepEqual(kinds(transcript), ['message', 'message', 'tool_call', 'message', 'turn_interrupted']);
  });

  it('a stop that needed the process killed is an interruption, not a failure', async () => {
    let fail: (err: Error) => void = () => {};
    outcome = () => new Promise((_, reject) => (fail = reject));
    const dispose = proc.dispose.bind(proc);
    proc.dispose = () => {
      dispose();
      fail(new Error('kiro-cli exited on SIGTERM'));
    };
    mgr = new SessionManager(noopLogger(), { spawn: () => proc, cancelGraceMs: 20 });
    await mgr.createChat({ cwd: sessionsCwd, chatId: 'endings-killed' });
    await mgr.runPrompt('endings-killed', [{ type: 'text', text: 'hang' }]);
    mgr.cancel('endings-killed');
    await settled('endings-killed');
    const { transcript } = await mgr.getDetail('endings-killed');
    assert.equal(transcript.at(-1)?.type, 'turn_interrupted');
    assert.ok(!transcript.some((i) => i.type === 'turn_error'));
  });

  it('a turn that finished normally stores nothing', async () => {
    outcome = async () => ({ stopReason: 'end_turn' });
    await start('endings-fine');
    assert.deepEqual(new ChatStore().turnEndingsByChat('endings-fine'), []);
  });

  it('deleting the chat removes what was stored for it', async () => {
    outcome = async () => ({ stopReason: 'cancelled' });
    await start('endings-deleted');
    assert.equal(new ChatStore().turnEndingsByChat('endings-deleted').length, 1);
    await mgr.deleteChat('endings-deleted');
    assert.deepEqual(new ChatStore().turnEndingsByChat('endings-deleted'), []);
  });
});
