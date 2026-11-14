// show_choice holds its tool call open through MCP elicitation until the user answers. These
// drive both ends: Casper's MCP server sending the elicitation, and SessionManager holding
// kiro's forwarded request until the user picks, types, or stops the turn.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHOICE_ANSWER_PREFIX, type CasperEvent } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import { SessionManager } from '../server/src/session/SessionManager.js';
import { McpConnection } from '../server/src/mcp/server.js';
import { CHOICE_NOT_WAITED } from '../server/src/mcp/protocol.js';
import { fakeKiroProcess, noopLogger, waitFor, type FakeProcess } from './helpers.js';

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-choice-sessions-'));
const sessionsCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-choice-cwd-')));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-choice-data-'));
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  for (const d of [sessionsDir, sessionsCwd, dataDir]) fs.rmSync(d, { recursive: true, force: true });
});

const choiceArgs = {
  question: 'Which layout?',
  options: [{ label: 'One column', prompt: 'Use one column' }, { label: 'Two columns' }],
};

describe("show_choice in Casper's MCP server", () => {
  const connect = (capabilities: Record<string, unknown>) => {
    const sent: Record<string, unknown>[] = [];
    const conn = new McpConnection((m) => sent.push(m as Record<string, unknown>));
    conn.receive({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities } });
    sent.length = 0;
    conn.receive({ id: 7, method: 'tools/call', params: { name: 'show_choice', arguments: choiceArgs } });
    return { conn, sent };
  };
  const resultText = (m: Record<string, unknown> | undefined) =>
    ((m?.result as { content: { text: string }[] }).content[0]!).text;

  it('asks the client with elicitation/create and answers the call with what the user sent', async () => {
    const { conn, sent } = connect({ elicitation: { form: {} } });
    assert.equal(sent.length, 1, 'the tool call waits: only the elicitation is sent');
    const ask = sent[0]!;
    assert.equal(ask.method, 'elicitation/create');
    assert.equal((ask.params as { message: string }).message, 'Which layout?');

    conn.receive({ id: ask.id as string, result: { action: 'accept', content: { answer: 'Use one column' } } });
    await waitFor('the tool result', () => sent.length === 2);
    assert.equal(sent[1]!.id, 7);
    assert.equal(resultText(sent[1]), `${CHOICE_ANSWER_PREFIX}Use one column`);
  });

  it('says the question closed when the user stopped the turn instead', async () => {
    const { conn, sent } = connect({ elicitation: {} });
    conn.receive({ id: sent[0]!.id as string, result: { action: 'cancel' } });
    await waitFor('the tool result', () => sent.length === 2);
    assert.equal(resultText(sent[1]), 'The question was closed without an answer.');
  });

  it('tells the model to end its turn when the client refuses the elicitation', async () => {
    const { conn, sent } = connect({ elicitation: { form: {} } });
    conn.receive({ id: sent[0]!.id as string, error: { code: -32601, message: 'Method not found' } });
    await waitFor('the tool result', () => sent.length === 2);
    assert.equal(resultText(sent[1]), CHOICE_NOT_WAITED);
  });

  it('answers at once when the client offers no elicitation', () => {
    const { sent } = connect({});
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.id, 7);
    assert.equal(resultText(sent[0]), CHOICE_NOT_WAITED);
  });
});

describe('a choice the turn waits on', () => {
  const choiceCall = (sessionId: string, toolCallId: string, server = 'casper', tool = 'show_choice') => ({
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId, title: `@${server}/${tool}`, status: 'in_progress', rawInput: choiceArgs,
        _meta: { kiro: { serverName: server } },
      },
    },
  });

  /** A chat with a turn running on the fake process, which has just called show_choice. */
  async function waitingChat(sessionId: string) {
    let finish!: (stopReason: 'end_turn' | 'cancelled') => void;
    const proc: FakeProcess = fakeKiroProcess({
      sessionId,
      onPrompt: () => new Promise((resolve) => (finish = (stopReason) => resolve({ stopReason }))),
    });
    const mgr = new SessionManager(noopLogger(), { spawn: () => proc });
    const { summary } = await mgr.createChat({ cwd: sessionsCwd });
    const chatId = summary.chatId;
    await mgr.runPrompt(chatId, [{ type: 'text', text: 'Ask me which layout.' }]);
    const head = mgr.getStore(chatId)!.head();
    proc.bus.emit('notification', choiceCall(sessionId, 'choice-1'));
    proc.bus.emit('elicitation', 41, { sessionId, toolCallId: 'choice-1', elicitation: { mode: 'form', message: 'Which layout?' } });
    const events = () => mgr.getStore(chatId)!.getSince(head).events.map((e: CasperEvent) => e.payload).filter((p) => p.kind !== 'session_update');
    const answers = () => proc.args.filter((_, i) => proc.calls[i] === 'answerElicitation');
    return { mgr, proc, chatId, events, answers, finish: (r: 'end_turn' | 'cancelled' = 'end_turn') => finish(r) };
  }

  it('waits until the user picks, then answers kiro with the pick', async () => {
    const c = await waitingChat('sess_pick');
    try {
      assert.deepEqual(c.events(), [{ kind: 'choice_waiting', toolCallId: 'choice-1' }]);
      assert.deepEqual(c.answers(), [], 'nothing is answered before the user picks');
      assert.equal((await c.mgr.getDetail(c.chatId)).observability.waitingChoice, 'choice-1');

      c.mgr.answerChoice(c.chatId, 'choice-1', 'Use one column');
      assert.deepEqual(c.answers(), [[41, { action: 'accept', content: { answer: 'Use one column' } }]]);
      assert.deepEqual(c.events().at(-1), { kind: 'choice_settled', toolCallId: 'choice-1', answer: 'Use one column' });
      assert.throws(() => c.mgr.answerChoice(c.chatId, 'choice-1', 'Again'), /no longer waiting/);
      c.finish();
    } finally {
      c.mgr.disposeAll();
    }
  });

  it('takes a message typed into the running turn as the answer, not as a steer', async () => {
    const c = await waitingChat('sess_typed');
    try {
      await c.mgr.steer(c.chatId, 'Neither, use a grid', 'pending-3');
      assert.equal(c.proc.calls.includes('steer'), false);
      assert.deepEqual(c.answers(), [[41, { action: 'accept', content: { answer: 'Neither, use a grid' } }]]);
      assert.deepEqual(c.events().at(-1), {
        kind: 'choice_settled', toolCallId: 'choice-1', answer: 'Neither, use a grid', clientId: 'pending-3',
      });
      c.finish();
    } finally {
      c.mgr.disposeAll();
    }
  });

  it('closes the choice when the user stops the turn', async () => {
    const c = await waitingChat('sess_stop');
    try {
      c.mgr.cancel(c.chatId);
      assert.deepEqual(c.answers(), [[41, { action: 'cancel' }]]);
      assert.deepEqual(c.events().at(-1), { kind: 'choice_settled', toolCallId: 'choice-1' });
      c.finish('cancelled');
      await waitFor('the turn to end', () => c.events().some((p) => p.kind === 'turn_ended'));
      assert.equal((await c.mgr.getDetail(c.chatId)).observability.waitingChoice, undefined);
    } finally {
      c.mgr.disposeAll();
    }
  });

  it("declines an elicitation that is not a show_choice call's", async () => {
    const c = await waitingChat('sess_other');
    try {
      // Answered first, so only the tool's name stands between this elicitation and the user.
      c.mgr.answerChoice(c.chatId, 'choice-1', 'Use one column');
      c.proc.bus.emit('notification', choiceCall('sess_other', 'figma-1', 'figma', 'get_figma_data'));
      c.proc.bus.emit('elicitation', 42, { sessionId: 'sess_other', toolCallId: 'figma-1' });
      assert.deepEqual(c.answers().at(-1), [42, { action: 'decline' }]);
      assert.equal(c.events().filter((p) => p.kind === 'choice_waiting').length, 1, 'only the show_choice call waited');
      c.finish();
    } finally {
      c.mgr.disposeAll();
    }
  });
});
