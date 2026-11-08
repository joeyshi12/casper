// Titles, context breakdown, effort, and branching and rewinding a chat, driven through
// SessionManager with fake kiro processes.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CasperEvent, SessionConfigOption } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import { ChatStore } from '../server/src/session/chatStore.js';
import { chatDir } from '../server/src/session/chats.js';
import { kiroModels, rememberKiroModels } from '../server/src/session/kiroModels.js';
import { listModels } from '../server/src/session/models.js';
import { hydrateTranscript, promptCount, readPersistedSession } from '../server/src/session/kiroFiles.js';
import { SessionManager } from '../server/src/session/SessionManager.js';
import { fakeKiroProcess, noopLogger, waitFor, writeV3Session, type FakeProcess, type V3Line } from './helpers.js';

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-cuts-sessions-'));
const sessionsCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-cuts-cwd-')));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-cuts-data-'));
(config as { kiroSessionsDir: string }).kiroSessionsDir = sessionsDir;
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  for (const d of [sessionsDir, sessionsCwd, dataDir]) fs.rmSync(d, { recursive: true, force: true });
});

const store = new ChatStore();

const info = (sessionId: string, kiro: Record<string, unknown>) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'session_info_update', _meta: { kiro } } },
});

const configUpdate = (sessionId: string, configOptions: SessionConfigOption[]) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions } },
});

const modelOption = (current: string): SessionConfigOption => ({
  id: 'model',
  currentValue: current,
  options: [
    { value: 'auto', name: 'Auto', _meta: { kiro: { hasEffort: false } } },
    { value: 'claude-opus-5.5', name: 'Claude Opus 5.5', _meta: { kiro: { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffortLevel: 'medium' } } },
  ],
});
const effortOption = (current: string): SessionConfigOption => ({ id: 'effortLevel', currentValue: current });

const payloads = (events: CasperEvent[]) => events.map((e) => e.payload);

/** A manager whose spawns take the given processes in order. */
function managerOn(procs: FakeProcess[], opts: { defaultEffort?: string } = {}): SessionManager {
  const queue = [...procs];
  return new SessionManager(noopLogger(), {
    spawn: () => {
      const next = queue.shift();
      if (!next) throw new Error('no fake process left');
      return next;
    },
    defaultEffort: async (modelId) => (modelId === 'claude-opus-5.5' ? opts.defaultEffort : undefined),
  });
}

describe("kiro's session updates", () => {
  it("records the context breakdown as percentages, kiro's title once, and the prompt's id", async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_updates' });
    const mgr = managerOn([proc]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      const head = mgr.getStore(summary.chatId)!.head();
      proc.bus.emit('notification', info('sess_updates', {
        kind: 'context_usage',
        usagePercentage: 9.5,
        breakdown: {
          yourPrompts: { tokens: 120, percent: 1.25 },
          kiroResponses: { tokens: 300, percent: 3 },
          tools: { tokens: 50, percent: 0.5, mcp: 0, builtin: 50 },
          contextFiles: { tokens: 0, percent: 0 },
          memory: { tokens: 0, percent: -1 },
        },
      }));
      proc.bus.emit('notification', info('sess_updates', { kind: 'focus_update', title: 'Single Word Response Format' }));
      proc.bus.emit('notification', info('sess_updates', { kind: 'focus_update', title: 'Single Word Response Format' }));
      proc.bus.emit('notification', info('sess_updates', { kind: 'user_message_id_assigned', userMessageId: 'msg-1' }));

      assert.deepEqual(payloads(mgr.getStore(summary.chatId)!.getSince(head).events), [
        {
          kind: 'metadata',
          params: {
            sessionId: 'sess_updates',
            contextUsagePercentage: 9.5,
            contextBreakdown: { prompts: 1.25, responses: 3, tools: 0.5, contextFiles: 0, sessionFiles: 0, memory: 0 },
          },
        },
        { kind: 'title_changed', title: 'Single Word Response Format' },
        { kind: 'prompt_id', messageId: 'msg-1' },
      ]);
      const listed = (await mgr.listChats()).find((c) => c.chatId === summary.chatId);
      assert.equal(listed?.title, 'Single Word Response Format', "kiro's title names the chat");
      const detail = await mgr.getDetail(summary.chatId);
      assert.equal(detail.observability.contextBreakdown?.responses, 3);
    } finally {
      mgr.disposeAll();
    }
  });

  it('a rename still wins over the title kiro sends later', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_renamed' });
    const mgr = managerOn([proc]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      mgr.renameChat(summary.chatId, 'My name');
      proc.bus.emit('notification', info('sess_renamed', { kind: 'focus_update', title: 'Kiro name' }));
      assert.equal((await mgr.listChats()).find((c) => c.chatId === summary.chatId)?.title, 'My name');
    } finally {
      mgr.disposeAll();
    }
  });

  it('a prompt does not name the chat, so the title kiro makes from it can', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_prompted' });
    const mgr = managerOn([proc]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      await mgr.runPrompt(summary.chatId, [{ type: 'text', text: 'Reply with one word: apple.' }]);
      assert.equal(store.getTitle(summary.chatId), undefined);
    } finally {
      mgr.disposeAll();
    }
  });
});

describe('effort', () => {
  it("passes the model's default effort to a new chat, and a picked one in its place", async () => {
    const a = fakeKiroProcess({ sessionId: 'sess_effort_a' });
    const b = fakeKiroProcess({ sessionId: 'sess_effort_b' });
    const mgr = managerOn([a, b], { defaultEffort: 'xhigh' });
    try {
      await mgr.createChat({ cwd: sessionsCwd, modelId: 'claude-opus-5.5' });
      await mgr.createChat({ cwd: sessionsCwd, modelId: 'claude-opus-5.5', effortLevel: 'low' });
      const effortOf = (p: FakeProcess) =>
        (p.args[p.calls.indexOf('newSession')]![0] as { _meta: { kiro: { effortLevel?: string } } })._meta.kiro.effortLevel;
      assert.equal(effortOf(a), 'xhigh');
      assert.equal(effortOf(b), 'low');
    } finally {
      mgr.disposeAll();
    }
  });

  it("follows the model and effort kiro reports, and keeps each model's levels", async () => {
    const proc = fakeKiroProcess({
      sessionId: 'sess_settings',
      configOptions: [modelOption('claude-opus-5.5'), effortOption('medium')],
    });
    const mgr = managerOn([proc]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      assert.equal(summary.effortLevel, 'medium');
      assert.deepEqual(kiroModels().get('claude-opus-5.5'), {
        name: 'Claude Opus 5.5',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        recommended: 'medium',
      });
      assert.deepEqual(kiroModels().get('auto'), { name: 'Auto', levels: [] });

      await mgr.setEffort(summary.chatId, 'high');
      assert.deepEqual(proc.args[proc.calls.indexOf('setEffort')], ['sess_settings', 'high']);

      const head = mgr.getStore(summary.chatId)!.head();
      proc.bus.emit('notification', configUpdate('sess_settings', [modelOption('claude-opus-5.5'), effortOption('high')]));
      assert.equal(mgr.getStore(summary.chatId)!.head(), head, 'nothing changed, so nothing is recorded');
      // A model without effort levels has no effort option.
      proc.bus.emit('notification', configUpdate('sess_settings', [modelOption('auto')]));
      assert.deepEqual(payloads(mgr.getStore(summary.chatId)!.getSince(head).events), [
        { kind: 'settings_changed', modelId: 'auto', effortLevel: null },
      ]);
      const listed = (await mgr.listChats()).find((c) => c.chatId === summary.chatId);
      assert.equal(listed?.modelId, 'auto');
      assert.equal(listed?.effortLevel, undefined);
    } finally {
      mgr.disposeAll();
    }
  });

  it("lists models by kiro's names, with their levels and the user's own default effort", async () => {
    rememberKiroModels([modelOption('auto')]);
    const bin = path.join(dataDir, 'fake-kiro.sh');
    const models = JSON.stringify({
      models: ['auto', 'claude-opus-5.5'].map((id) => ({
        model_id: id, model_name: id, description: '', context_window_tokens: 1, rate_multiplier: 1, rate_unit: 'Credit',
      })),
    });
    fs.writeFileSync(
      bin,
      [
        '#!/usr/bin/env bash',
        `if [ "$1" = chat ]; then echo '${models}'; exit 0; fi`,
        `if [ "$2" = chat.modelDefaults ]; then echo '{"claude-opus-5.5":{"output_config":{"effort":"xhigh"}}}'; exit 0; fi`,
        'exit 1',
      ].join('\n'),
      { mode: 0o755 },
    );
    const prev = config.kiroBin;
    (config as { kiroBin: string }).kiroBin = bin;
    try {
      const listed = await listModels(noopLogger());
      assert.deepEqual(
        listed.map((m) => [m.modelName, m.effortLevels, m.recommendedEffort, m.defaultEffort]),
        [
          ['Auto', undefined, undefined, undefined],
          ['Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', 'xhigh'],
        ],
      );
    } finally {
      (config as { kiroBin: string }).kiroBin = prev;
    }
  });

  it('replaces the stored models with the latest report', () => {
    rememberKiroModels([modelOption('auto')]);
    rememberKiroModels([{ id: 'model', options: [{ value: 'kimi', _meta: { kiro: { effortLevels: ['low', 'high', 'max'] } } }] }]);
    assert.deepEqual([...kiroModels().keys()], ['kimi']);
    assert.deepEqual(kiroModels().get('kimi'), { levels: ['low', 'high', 'max'] });
  });
});

describe('branching and rewinding a chat', () => {
  const at = (s: number) => `2026-11-07T07:00:${String(s).padStart(2, '0')}.000Z`;
  const prompt = (id: string, text: string, s: number): V3Line => ({ id, timestamp: at(s), payload: { type: 'user', content: text } });
  const reply = (id: string, text: string, s: number): V3Line => ({
    id,
    timestamp: at(s),
    payload: { type: 'assistant', content: text },
  });

  /** A chat bound to a kiro session holding three turns, with an attachment on the first
   *  and third prompts and a stopped turn stored for the third. */
  async function chatWithTurns(mgr: SessionManager, sessionId: string) {
    const { summary } = await mgr.createChat({ cwd: sessionsCwd, modelId: 'claude-opus-5.5', effortLevel: 'high' });
    writeV3Session(sessionsDir, {
      id: sessionId,
      cwd: sessionsCwd,
      title: 'Three turns',
      messages: [
        prompt('u1', 'one', 10), reply('a1', 'first', 11),
        prompt('u2', 'two', 20), reply('a2', 'second', 21),
        prompt('u3', 'three', 30), reply('a3', 'third', 31),
      ],
    });
    const uploads = path.join(chatDir(summary.chatId), 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, 'a.txt'), 'a');
    store.setAttachments(summary.chatId, 0, [{ path: path.join(uploads, 'a.txt'), name: 'a.txt', size: 1, kind: 'text' }]);
    store.setAttachments(summary.chatId, 2, [{ path: '/elsewhere/c.txt', name: 'c.txt', size: 1, kind: 'text' }]);
    const stopped = (s: number) => ({ startedAt: Date.parse(at(s)) - 100, endedAt: Date.parse(at(s)) + 500, prompt: 'x', kind: 'interrupted' as const, items: [] });
    store.addTurnEnding(summary.chatId, stopped(10));
    store.addTurnEnding(summary.chatId, stopped(30));
    return summary.chatId;
  }

  it("branches into a new chat that keeps the conversation through one prompt's turn", async () => {
    const parent = fakeKiroProcess({ sessionId: 'sess_parent' });
    const branch = fakeKiroProcess({ sessionId: 'sess_branch' });
    const mgr = managerOn([parent, branch]);
    try {
      const chatId = await chatWithTurns(mgr, 'sess_parent');
      const detail = await mgr.branchChat(chatId, 'u2');
      const branchId = detail.summary.chatId;

      assert.notEqual(branchId, chatId);
      assert.equal(detail.summary.sessionId, 'sess_branch');
      assert.deepEqual(branch.args[branch.calls.indexOf('forkSession')], [
        { sessionId: 'sess_parent', cwd: sessionsCwd, mcpServers: [], _meta: { kiro: { messageId: 'u2' } } },
      ]);
      // kiro answers a fork with only the new id, so the copy is loaded after it.
      assert.deepEqual(branch.calls.filter((c) => c.endsWith('Session')), ['forkSession', 'loadSession']);
      assert.equal((branch.args[branch.calls.indexOf('loadSession')]![0] as { sessionId: string }).sessionId, 'sess_branch');
      // A fork starts on kiro's default model, so the parent's model and effort are set again.
      assert.deepEqual(branch.args[branch.calls.indexOf('setModel')], ['sess_branch', 'claude-opus-5.5']);
      assert.deepEqual(branch.args[branch.calls.indexOf('setEffort')], ['sess_branch', 'high']);
      assert.equal(detail.summary.modelId, 'claude-opus-5.5');
      assert.equal(detail.summary.effortLevel, 'high');
      // The first prompt's upload moved with the chat's files; the third prompt is not kept.
      const copied = path.join(chatDir(branchId), 'uploads', 'a.txt');
      assert.deepEqual([...store.attachmentsByChat(branchId).entries()], [[0, [{ path: copied, name: 'a.txt', size: 1, kind: 'text' }]]]);
      assert.equal(fs.readFileSync(copied, 'utf8'), 'a');
      assert.equal(store.turnEndingsByChat(branchId).length, 1, "only the stopped turn before the cut");
      assert.equal(store.sessionIdForChat(chatId), 'sess_parent', 'the parent is unchanged');
      await assert.rejects(mgr.branchChat(chatId, 'nope'), /Unknown message/);
    } finally {
      mgr.disposeAll();
    }
  });

  it('rewinds the chat onto a copy that ends before the prompt, and tells clients to refetch', async () => {
    const first = fakeKiroProcess({ sessionId: 'sess_long' });
    const rewound = fakeKiroProcess({ sessionId: 'sess_rewound' });
    const mgr = managerOn([first, rewound]);
    try {
      const chatId = await chatWithTurns(mgr, 'sess_long');
      const head = mgr.getStore(chatId)!.head();
      const detail = await mgr.rewindChat(chatId, 'u3');

      assert.deepEqual((rewound.args[rewound.calls.indexOf('forkSession')]![0] as { _meta: unknown })._meta, { kiro: { messageId: 'u2' } });
      assert.equal(store.sessionIdForChat(chatId), 'sess_rewound');
      assert.equal(detail.summary.chatId, chatId);
      assert.ok(first.disposed(), "the old session's process is stopped");
      assert.deepEqual([...store.attachmentsByChat(chatId).keys()], [0]);
      assert.equal(store.turnEndingsByChat(chatId).length, 1);
      assert.deepEqual(payloads(mgr.getStore(chatId)!.getSince(head).events), [{ kind: 'history_replaced' }]);
    } finally {
      mgr.disposeAll();
    }
  });

  it('rewinding to the first prompt starts an empty session with the same settings', async () => {
    const first = fakeKiroProcess({ sessionId: 'sess_first' });
    const fresh = fakeKiroProcess({ sessionId: 'sess_fresh' });
    const mgr = managerOn([first, fresh]);
    try {
      const chatId = await chatWithTurns(mgr, 'sess_first');
      await mgr.rewindChat(chatId, 'u1');
      assert.deepEqual(fresh.calls.filter((c) => c === 'forkSession' || c === 'newSession'), ['newSession']);
      assert.equal(store.sessionIdForChat(chatId), 'sess_fresh');
      assert.equal(store.attachmentsByChat(chatId).size, 0);
      assert.equal(store.turnEndingsByChat(chatId).length, 0);
    } finally {
      mgr.disposeAll();
    }
  });

  it('refuses to rewind while a turn runs', async () => {
    let finish!: () => void;
    const proc = fakeKiroProcess({
      sessionId: 'sess_busy',
      onPrompt: () => new Promise((resolve) => (finish = () => resolve({ stopReason: 'end_turn' }))),
    });
    const mgr = managerOn([proc]);
    try {
      const chatId = await chatWithTurns(mgr, 'sess_busy');
      await mgr.runPrompt(chatId, [{ type: 'text', text: 'four' }]);
      await assert.rejects(mgr.rewindChat(chatId, 'u2'), /turn is running/);
      finish();
    } finally {
      mgr.disposeAll();
    }
  });
});

describe('usage and memories', () => {
  it("reports the chat's credits, the plan, and the context breakdown kiro gives on request", async () => {
    const proc = fakeKiroProcess({
      sessionId: 'sess_usage',
      breakdown: { yourPrompts: { percent: 1.5 }, kiroResponses: { percent: 4 } },
      account: {
        success: true,
        data: {
          planName: 'KIRO POWER',
          billingCycleReset: '2026-12-01',
          usageBreakdowns: [{ resourceType: 'CREDIT', used: 11571.31, limit: 10000, hasLimit: true, overageCharges: 62.85, currency: 'USD' }],
        },
      },
    });
    const mgr = managerOn([proc]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      const usageLine = (id: string, usage: number): V3Line => ({
        id,
        timestamp: '2026-11-07T07:00:00.000Z',
        payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage }] },
      });
      // The second copy of a line, as kiro's import from kiro 2.x can leave, counts once.
      writeV3Session(sessionsDir, { id: 'sess_usage', cwd: sessionsCwd, messages: [usageLine('t1', 0.25), usageLine('t2', 0.5), usageLine('t2', 0.5)] });
      const head = mgr.getStore(summary.chatId)!.head();

      const usage = await mgr.getUsage(summary.chatId);
      assert.deepEqual(usage, {
        credits: 0.75,
        account: { planName: 'KIRO POWER', used: 11571.31, limit: 10000, resetsOn: '2026-12-01', overageCharges: 62.85, currency: 'USD' },
      });
      assert.deepEqual(payloads(mgr.getStore(summary.chatId)!.getSince(head).events), [
        {
          kind: 'metadata',
          params: {
            sessionId: 'sess_usage',
            contextBreakdown: { prompts: 1.5, responses: 4, tools: 0, contextFiles: 0, sessionFiles: 0, memory: 0 },
          },
        },
      ]);

      // A live report wins over the file, which kiro writes after it.
      proc.bus.emit('notification', info('sess_usage', { kind: 'session_usage', credits: [{ usage: 0.9, unit: 'credit' }] }));
      assert.equal((await mgr.getUsage(summary.chatId)).credits, 0.9);
      assert.equal(proc.calls.filter((c) => c === 'accountUsage').length, 1, 'the plan is read once a minute');
    } finally {
      mgr.disposeAll();
    }
  });

  it('keeps the credits a load replays', async () => {
    const proc = fakeKiroProcess({ sessionId: 'sess_replayed' });
    const mgr = managerOn([proc]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      const head = mgr.getStore(summary.chatId)!.head();
      proc.bus.emit('notification', info('sess_replayed', { kind: 'session_usage', credits: [{ usage: 2 }], replay: true }));
      proc.bus.emit('notification', info('sess_replayed', { kind: 'context_usage', usagePercentage: 5, replay: true }));
      assert.deepEqual(payloads(mgr.getStore(summary.chatId)!.getSince(head).events), [
        { kind: 'metadata', params: { sessionId: 'sess_replayed', sessionCredits: 2 } },
      ]);
    } finally {
      mgr.disposeAll();
    }
  });

  it('lists and deletes memories on a process started for the call', async () => {
    const proc = fakeKiroProcess({
      memories: [{ id: 'm1', memoryType: 'USER_PREFERENCE', title: 'tabs', summary: 'Uses tabs', scopes: ['Global'], createdAt: '2026-11-08T11:05:11.776Z' }, { title: 'no id' }],
    });
    const mgr = managerOn([proc]);
    try {
      assert.deepEqual(await mgr.listMemories(), [
        { id: 'm1', memoryType: 'USER_PREFERENCE', title: 'tabs', summary: 'Uses tabs', scopes: ['Global'], updatedAt: '2026-11-08T11:05:11.776Z' },
      ]);
      assert.ok(proc.disposed(), 'the process started for it is stopped');
    } finally {
      mgr.disposeAll();
    }
  });
});

describe('messages sent into a running turn', () => {
  const at = (s: number) => `2026-11-08T08:00:${String(s).padStart(2, '0')}.000Z`;
  const ln = (id: string, s: number, payload: Record<string, unknown>): V3Line => ({ id, timestamp: at(s), payload });

  it('shows a steer where the model read it, and counts it as no prompt', async () => {
    writeV3Session(sessionsDir, {
      id: 'sess_steered',
      cwd: sessionsCwd,
      messages: [
        ln('u1', 1, { type: 'user', content: 'Run two commands.' }),
        ln('a1', 2, { type: 'assistant', content: 'Running the first.' }),
        ln('steer-x', 3, { type: 'user', content: 'Also say BANANA.', source: 'steer' }),
        ln('inj', 4, {
          type: 'user',
          content: '[LIVE STEERING - New message from user] ...',
          _meta: { kiro: { syntheticUserMessageReason: 'steering-injection', steeringConsumedIds: ['steer-x'] } },
        }),
        ln('a2', 5, { type: 'assistant', content: 'Done. BANANA.' }),
        ln('t1-usage', 6, { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage: 0.04 }, { usage: 0.02 }], elapsedTime: 10521 }),
        ln('steering_boundary_1', 7, { type: 'user', content: '', source: 'steer', _meta: { kiro: { steeringClearedIds: ['steer-x'] } } }),
        // Sent after the turn ended and never read.
        ln('steer-late', 8, { type: 'user', content: 'late', source: 'steer' }),
      ],
    });
    const items = await hydrateTranscript('sess_steered');
    assert.deepEqual(
      items.map((it) =>
        it.type === 'message' ? `${it.message.role}${it.message.steer ? '(steer)' : ''}:${it.message.text}` : it.type === 'turn_stats' ? `stats:${it.elapsedMs}:${it.credits?.toFixed(2)}` : it.type,
      ),
      ['user:Run two commands.', 'assistant:Running the first.', 'user(steer):Also say BANANA.', 'assistant:Done. BANANA.', 'stats:10521:0.06'],
    );
    assert.equal(await promptCount('sess_steered'), 1);
  });

  it('leaves out what kiro rewound', async () => {
    writeV3Session(sessionsDir, {
      id: 'sess_reverted',
      cwd: sessionsCwd,
      messages: [
        ln('r1', 1, { type: 'user', content: 'one' }),
        ln('ra', 2, { type: 'assistant', content: 'reply' }),
        ln('r2', 3, { type: 'user', content: 'two' }),
        ln('rb', 4, { type: 'assistant', content: 'partial' }),
        ln('tombstone_r2_x', 5, { type: 'tombstone', kind: 'checkpoint_revert', effectiveFromMessageId: 'r2' }),
        ln('r3', 6, { type: 'user', content: 'two, again' }),
      ],
    });
    const items = await hydrateTranscript('sess_reverted');
    assert.deepEqual(
      items.map((it) => (it.type === 'message' ? it.message.text : it.type)),
      ['one', 'reply', 'two, again'],
    );
    assert.equal(await promptCount('sess_reverted'), 2);
  });

  /** A chat whose turn waits until `finish` is called. */
  async function runningChat(sessionId: string, extra: Parameters<typeof fakeKiroProcess>[0] = {}) {
    let finish!: () => void;
    const proc = fakeKiroProcess({
      sessionId,
      onPrompt: () => new Promise((resolve) => (finish = () => resolve({ stopReason: 'end_turn' }))),
      ...extra,
    });
    const mgr = managerOn([proc]);
    const { summary } = await mgr.createChat({ cwd: sessionsCwd });
    await mgr.runPrompt(summary.chatId, [{ type: 'text', text: 'Work.' }]);
    return { mgr, proc, chatId: summary.chatId, finish: () => finish() };
  }

  it('sends it into the turn, shows it once read, and gives back one the turn never read', async () => {
    const { mgr, proc, chatId, finish } = await runningChat('sess_steer_live');
    try {
      const head = mgr.getStore(chatId)!.head();
      await mgr.steer(chatId, '  Also say BANANA.  ', 'pending-1');
      await mgr.steer(chatId, 'Too late.', 'pending-2');
      const [sid, message, id] = proc.args[proc.calls.indexOf('steer')] as [string, string, string];
      assert.equal(sid, 'sess_steer_live');
      assert.equal(message, 'Also say BANANA.');
      // kiro names the steer `steer-<the id it was given>`.
      proc.bus.emit('notification', info('sess_steer_live', { kind: 'steering_injected', messageId: `steer-${id}`, content: message }));
      proc.bus.emit('notification', info('sess_steer_live', { kind: 'turn_completion', promptTurnSummaries: [{ usage: 0.5 }], elapsedTime: 2000 }));
      finish();
      await waitFor('the turn to end', () => payloads(mgr.getStore(chatId)!.getSince(head).events).some((p) => p.kind === 'turn_ended'));
      assert.deepEqual(payloads(mgr.getStore(chatId)!.getSince(head).events), [
        { kind: 'steer_injected', text: 'Also say BANANA.', clientId: 'pending-1' },
        { kind: 'steer_dropped', text: 'Too late.', clientId: 'pending-2' },
        { kind: 'turn_ended', stopReason: 'end_turn', stats: { elapsedMs: 2000, credits: 0.5 } },
      ]);
      assert.ok(proc.calls.includes('clearSteers'), "kiro's unread steer is dropped, so no later turn takes it");
      await assert.rejects(mgr.steer(chatId, 'after'), /No turn is running/);
    } finally {
      mgr.disposeAll();
    }
  });
});

describe('retrying a failed turn', () => {
  async function failedChat(sessionId: string, opts: { output: boolean; revert?: boolean }) {
    let first = true;
    const proc = fakeKiroProcess({
      sessionId,
      revert: opts.revert,
      onPrompt: async () => {
        if (!first) return { stopReason: 'end_turn' };
        first = false;
        proc.bus.emit('notification', info(sessionId, { kind: 'user_message_id_assigned', userMessageId: 'p2' }));
        if (opts.output) {
          proc.bus.emit('notification', {
            method: 'session/update',
            params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial' } } },
          });
        }
        throw new Error('model at capacity');
      },
    });
    const mgr = managerOn([proc]);
    const { summary } = await mgr.createChat({ cwd: sessionsCwd });
    writeV3Session(sessionsDir, {
      id: sessionId,
      cwd: sessionsCwd,
      messages: [
        { id: 'p1', timestamp: '2026-11-08T08:00:00.000Z', payload: { type: 'user', content: 'First.' } },
        { id: 'p2', timestamp: '2026-11-08T08:00:10.000Z', payload: { type: 'user', content: 'Second.' } },
      ],
    });
    const chatId = summary.chatId;
    store.setAttachments(chatId, 1, [{ path: '/tmp/x.txt', name: 'x.txt', size: 1, kind: 'text' }]);
    const head = mgr.getStore(chatId)!.head();
    await mgr.runPrompt(chatId, [{ type: 'text', text: 'Second.' }]);
    await waitFor('the turn to fail', () => payloads(mgr.getStore(chatId)!.getSince(head).events).some((p) => p.kind === 'turn_error'));
    return { mgr, proc, chatId };
  }

  it('removes a failed turn kiro kept only the prompt of, before sending it again', async () => {
    const { mgr, proc, chatId } = await failedChat('sess_retry_empty', { output: false });
    try {
      await mgr.runPrompt(chatId, [{ type: 'text', text: 'Second.' }], undefined, { retry: true });
      assert.deepEqual(proc.args[proc.calls.indexOf('revertTo')], ['sess_retry_empty', 'p2']);
      assert.deepEqual([...store.attachmentsByChat(chatId).keys()], [], "the failed prompt's files go with it");
      assert.equal(store.turnEndingsByChat(chatId).length, 0, 'and its stored ending');
      assert.ok(payloads(mgr.getStore(chatId)!.getSince(0).events).some((p) => p.kind === 'history_replaced'));
      assert.ok(proc.calls.indexOf('revertTo') < proc.calls.lastIndexOf('prompt'));
    } finally {
      mgr.disposeAll();
    }
  });

  it('leaves a failed turn that did something, and a prompt that is no retry', async () => {
    const worked = await failedChat('sess_retry_output', { output: true });
    try {
      await worked.mgr.runPrompt(worked.chatId, [{ type: 'text', text: 'Second.' }], undefined, { retry: true });
      assert.equal(worked.proc.calls.includes('revertTo'), false);
    } finally {
      worked.mgr.disposeAll();
    }
    const plain = await failedChat('sess_retry_plain', { output: false });
    try {
      await plain.mgr.runPrompt(plain.chatId, [{ type: 'text', text: 'Something else.' }]);
      assert.equal(plain.proc.calls.includes('revertTo'), false);
    } finally {
      plain.mgr.disposeAll();
    }
  });

  it('keeps the attachments when kiro does not rewind', async () => {
    const { mgr, proc, chatId } = await failedChat('sess_retry_refused', { output: false, revert: false });
    try {
      await mgr.runPrompt(chatId, [{ type: 'text', text: 'Second.' }], undefined, { retry: true });
      assert.ok(proc.calls.includes('revertTo'));
      assert.deepEqual([...store.attachmentsByChat(chatId).keys()], [1]);
    } finally {
      mgr.disposeAll();
    }
  });
});

describe('rewinding deletes the session it leaves', () => {
  it("removes the old kiro session's files", async () => {
    const first = fakeKiroProcess({ sessionId: 'sess_left' });
    const next = fakeKiroProcess({ sessionId: 'sess_taken' });
    const mgr = managerOn([first, next]);
    try {
      const { summary } = await mgr.createChat({ cwd: sessionsCwd });
      writeV3Session(sessionsDir, {
        id: 'sess_left',
        cwd: sessionsCwd,
        messages: [
          { id: 'q1', timestamp: '2026-11-08T09:00:00.000Z', payload: { type: 'user', content: 'one' } },
          { id: 'q2', timestamp: '2026-11-08T09:00:10.000Z', payload: { type: 'user', content: 'two' } },
        ],
      });
      writeV3Session(sessionsDir, { id: 'sess_taken', cwd: sessionsCwd, messages: [] });
      await mgr.rewindChat(summary.chatId, 'q2');
      assert.ok(first.calls.includes('disposeAndWait'), 'the old process has exited before its files go');
      assert.equal(await readPersistedSession('sess_left'), null);
      assert.ok(await readPersistedSession('sess_taken'));
    } finally {
      mgr.disposeAll();
    }
  });
});
