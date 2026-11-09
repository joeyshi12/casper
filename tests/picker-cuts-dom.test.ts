// The model picker with its effort panel, the edit and branch actions on a sent message,
// and the store events behind them, rendered in jsdom.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo, TranscriptItem } from '@casper/shared';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let ModelPicker: Any;
let Transcript: Any;
let breakdownParts: Any;
let formatCredits: Any;
let useStore: Any;
let sessionController: Any;
let root: Any;
let host: HTMLElement;
let w: Any;

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  modelId: id,
  modelName: id.toUpperCase(),
  description: `About ${id}`,
  contextWindowTokens: 1000,
  rateMultiplier: 1,
  rateUnit: 'Credit',
  isDefault: false,
  ...extra,
});

const MODELS = [
  model('opus', { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], recommendedEffort: 'medium', defaultEffort: 'xhigh' }),
  model('haiku', { isDefault: true }),
];

const render = (el: Any) =>
  act(() => {
    root.render(el);
  });

const click = (el: Element | null) => {
  assert.ok(el, 'the element is there');
  act(() => {
    (el as HTMLElement).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  });
};

const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

const trigger = () => host.querySelector('.mp .dd-trigger') as HTMLElement;
const effortRow = () => host.querySelector('.mp-effort-row');
const levelNames = () => [...host.querySelectorAll('.mp-level .mp-option-name')].map((e) => e.textContent);

before(async () => {
  ({ window: w, host, react: { createElement, act } } = await installDomGlobals());
  w.HTMLElement.prototype.scrollIntoView = () => {};
  ({ createRoot } = await import('react-dom/client'));
  ({ ModelPicker } = await import('../web/src/components/controls/Pickers.js'));
  ({ Transcript } = await import('../web/src/components/chat/Transcript.js'));
  ({ breakdownParts } = await import('../web/src/components/observability/ContextRing.js'));
  ({ formatCredits } = await import('../web/src/util/credits.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
  ({ sessionController } = await import('../web/src/state/sessionController.js'));
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  act(() => root?.unmount());
  host.innerHTML = '';
  root = createRoot(host);
  useStore.getState().clearActive();
  useStore.setState({ models: MODELS });
});

describe('the model picker', () => {
  const picked: { model: string[]; effort: string[] } = { model: [], effort: [] };
  const picker = (props: Record<string, unknown>) =>
    createElement(ModelPicker, {
      onChange: (id: string) => picked.model.push(id),
      onEffortChange: (level: string) => picked.effort.push(level),
      ...props,
    });

  beforeEach(() => {
    picked.model = [];
    picked.effort = [];
  });

  it("shows a draft's default effort, and each model by name only", () => {
    render(picker({ value: 'opus', draft: true }));
    assert.equal(host.querySelector('.mp-trigger-effort')?.textContent, 'Extra');
    click(trigger());
    assert.deepEqual(
      [...host.querySelectorAll('.mp-list .mp-option-name')].map((e) => e.textContent),
      ['OPUS', 'HAIKU'],
    );
    assert.equal(host.querySelector('.mp-list')?.textContent?.includes('About opus'), false);
    assert.equal(host.querySelector('.mp-option.is-selected .mp-option-name')?.textContent, 'OPUS');
    assert.match(effortRow()?.textContent ?? '', /Effort\s*Extra/);
  });

  it("a chat without a known effort shows kiro's recommended one", () => {
    render(picker({ value: 'opus' }));
    assert.equal(host.querySelector('.mp-trigger-effort')?.textContent, 'Medium');
  });

  it('opens the effort panel, marks the recommended and costly levels, and picks one', () => {
    render(picker({ value: 'opus', effort: 'medium' }));
    click(trigger());
    click(effortRow());
    assert.deepEqual(levelNames(), ['Low', 'Medium', 'High', 'Extra', 'Max']);
    const pills = [...host.querySelectorAll('.mp-level')].map((r) => r.querySelector('.mp-pill')?.textContent ?? '');
    assert.deepEqual(pills, ['', 'Recommended', '', '', 'Uses the most credits']);
    assert.equal(host.querySelector('.mp-level.is-selected .mp-option-name')?.textContent, 'Medium');
    click([...host.querySelectorAll('.mp-level')][2]!);
    assert.deepEqual(picked.effort, ['high']);
    assert.equal(host.querySelector('.mp-panel'), null, 'picking closes the picker');
  });

  it('has no effort row for a model without levels', () => {
    render(picker({ value: 'haiku' }));
    assert.equal(host.querySelector('.mp-trigger-effort'), null);
    click(trigger());
    assert.equal(effortRow(), null);
  });

  it('works from the keyboard', () => {
    render(picker({ value: 'opus', effort: 'low' }));
    const t = trigger();
    key(t, 'ArrowDown'); // opens on the current model
    key(t, 'ArrowDown');
    key(t, 'ArrowDown'); // the effort row, after both models
    key(t, 'Enter');
    assert.equal(levelNames().length, 5, 'the effort panel opened');
    key(t, 'ArrowDown');
    key(t, 'Enter');
    assert.deepEqual(picked.effort, ['medium']);
    assert.deepEqual(picked.model, []);
  });
});

describe('editing and branching from a sent message', () => {
  const items: TranscriptItem[] = [
    { type: 'message', message: { id: 'u-1', role: 'user', text: 'first', messageId: 'm1' } },
    { type: 'message', message: { id: 'u-2', role: 'user', text: 'not saved yet' } },
  ];
  const calls: unknown[][] = [];
  let original: { editPrompt: Any; branchFrom: Any };

  before(() => {
    original = { editPrompt: sessionController.editPrompt, branchFrom: sessionController.branchFrom };
    sessionController.editPrompt = async (...a: unknown[]) => {
      calls.push(['edit', ...a]);
      return true;
    };
    sessionController.branchFrom = async (...a: unknown[]) => {
      calls.push(['branch', ...a]);
    };
  });
  after(() => Object.assign(sessionController, original));

  beforeEach(() => {
    calls.length = 0;
    useStore.setState({ activeId: 'c1', chatId: 'c1', items, remainingOlder: 0 });
    render(createElement(Transcript, {}));
  });

  const wraps = () => [...host.querySelectorAll('.msg-user-wrap')];

  it('offers both only on a message kiro has saved', () => {
    const [saved, unsaved] = wraps();
    assert.ok(saved!.querySelector('[aria-label="Edit message"]'));
    assert.ok(saved!.querySelector('[aria-label="Branch from here"]'));
    assert.equal(unsaved!.querySelector('.msg-user-actions'), null);
  });

  it('branches from the message', async () => {
    const button = wraps()[0]!.querySelector('[aria-label="Branch from here"]') as HTMLElement;
    await act(async () => {
      button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(calls, [['branch', 'm1']]);
  });

  it('edits the message in place and sends the new text', async () => {
    click(wraps()[0]!.querySelector('button[aria-label="Edit message"]'));
    const input = host.querySelector('textarea.msg-edit-input') as HTMLTextAreaElement;
    assert.equal(input.value, 'first');
    assert.equal(host.querySelector('.msg-edit p'), null, 'no help text under the box');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, 'first, again');
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    });
    const send = [...host.querySelectorAll('.msg-edit-actions button')].find((b) => b.textContent === 'Send')!;
    await act(async () => {
      send.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(calls, [['edit', 'm1', 'first, again', []]]);
  });

  it('cannot edit while a turn runs', () => {
    act(() => useStore.setState({ observability: { ...useStore.getState().observability, turnStatus: 'running' } }));
    assert.equal((wraps()[0]!.querySelector('[aria-label="Edit message"]') as HTMLButtonElement).disabled, true);
  });
});

describe('store events', () => {
  it("names the running turn's prompt", () => {
    const s = useStore.getState();
    useStore.setState({
      appliedSeq: 0,
      items: [
        { type: 'message', message: { id: 'u-1', role: 'user', text: 'old', messageId: 'm1' } },
        { type: 'message', message: { id: 'u-2', role: 'user', text: 'new' } },
      ],
    });
    s.applyEvent({ seq: 1, ts: 0, chatId: 'c1', payload: { kind: 'prompt_id', messageId: 'm2' } });
    assert.deepEqual(
      useStore.getState().items.map((it: Any) => it.message.messageId),
      ['m1', 'm2'],
    );
  });

  it('follows the model and effort kiro reports', () => {
    useStore.setState({ appliedSeq: 0, currentModelId: 'opus', currentEffort: 'high' });
    useStore.getState().applyEvent({ seq: 1, ts: 0, chatId: 'c1', payload: { kind: 'settings_changed', modelId: 'haiku', effortLevel: null } });
    assert.equal(useStore.getState().currentModelId, 'haiku');
    assert.equal(useStore.getState().currentEffort, undefined);
  });
});

describe('the context breakdown', () => {
  it('lists the parts kiro reports, and the rest of the used context as one more', () => {
    const parts = breakdownParts(10, { prompts: 1, responses: 3, tools: 2, contextFiles: 0, sessionFiles: 0.01, memory: 0 });
    assert.deepEqual(
      parts.map((p: Any) => [p.label, Number(p.pct.toFixed(2))]),
      [['Your messages', 1], ['Responses', 3], ['Tools', 2], ['System and other', 4]],
    );
    assert.deepEqual(breakdownParts(10, undefined), []);
  });
});

describe('credits', () => {
  it('formats like kiro, and never shows a small cost as nothing', () => {
    assert.equal(formatCredits(0.0367), '0.04');
    assert.equal(formatCredits(0.004), '<0.01');
    assert.equal(formatCredits(0), '0');
  });
});

describe('steering and turn stats (store and render)', () => {
  const apply = (seq: number, payload: unknown) => useStore.getState().applyEvent({ seq, ts: 1000 + seq, chatId: 'c1', payload });

  it('puts a read steer after what the turn had said, and fails one the turn never read', () => {
    useStore.setState({
      appliedSeq: 0,
      items: [{ type: 'message', message: { id: 'u-1', role: 'user', text: 'Work.', messageId: 'm1' } }],
      streamingText: 'Running the first.',
      pending: [
        { id: 'pending-1', text: 'Also say BANANA.', content: [], status: 'sending', steer: true },
        { id: 'pending-2', text: 'Too late.', content: [], status: 'sending', steer: true },
      ],
    });
    apply(1, { kind: 'steer_injected', text: 'Also say BANANA.', clientId: 'pending-1' });
    apply(2, { kind: 'steer_dropped', text: 'Too late.', clientId: 'pending-2' });
    const s = useStore.getState();
    assert.deepEqual(
      s.items.map((it: Any) => `${it.message.role}${it.message.steer ? '(steer)' : ''}:${it.message.text}`),
      ['user:Work.', 'assistant:Running the first.', 'user(steer):Also say BANANA.'],
    );
    assert.equal(s.streamingText, '');
    assert.deepEqual(s.pending.map((p: Any) => [p.id, p.status]), [['pending-2', 'failed']]);
  });

  it("a starting turn does not take a waiting steer for its own prompt", () => {
    useStore.setState({
      appliedSeq: 0,
      items: [],
      pending: [
        { id: 'pending-1', text: 'steer', content: [], status: 'sending', steer: true },
        { id: 'pending-2', text: 'prompt', content: [], status: 'sending' },
      ],
    });
    apply(1, { kind: 'turn_started', prompt: [{ type: 'text', text: 'prompt' }] });
    assert.deepEqual(useStore.getState().pending.map((p: Any) => p.id), ['pending-1']);
  });

  it('shows what a turn took under its reply', async () => {
    useStore.setState({ appliedSeq: 0, activeId: 'c1', chatId: 'c1', items: [], streamingText: 'Done.', pending: [] });
    apply(1, { kind: 'turn_ended', stopReason: 'end_turn', stats: { elapsedMs: 10521, credits: 0.0619 } });
    assert.deepEqual(useStore.getState().items.map((it: Any) => it.type), ['message', 'turn_stats']);
    const { TurnStatsLine } = await import('../web/src/components/chat/TranscriptEntries.js');
    const stats = useStore.getState().items[1];
    await act(async () => {
      root.render(createElement(TurnStatsLine, { elapsedMs: stats.elapsedMs, credits: stats.credits }));
    });
    assert.equal(host.querySelector('.turn-stats')?.textContent, '11s · 0.06 credits');
    await act(async () => {
      root.render(createElement(TurnStatsLine, { elapsedMs: 4200 }));
    });
    assert.equal(host.querySelector('.turn-stats')?.textContent, '4.2s');
  });

  it('retries a failed turn as a retry, and sends a read-back steer as a prompt once the turn is over', () => {
    const sent: unknown[] = [];
    const socket = {
      prompt: (...a: unknown[]) => (sent.push(['prompt', ...a]), true),
      steer: (...a: unknown[]) => (sent.push(['steer', ...a]), true),
    };
    (sessionController as Any).socket = socket;
    try {
      sessionController.retryTurn('Second.');
      assert.deepEqual(sent.at(-1), ['prompt', [{ type: 'text', text: 'Second.' }], undefined, true]);

      useStore.setState({ observability: { ...useStore.getState().observability, turnStatus: 'running' }, pending: [] });
      sessionController.steer('  more  ');
      const [kind, text, id] = sent.at(-1) as [string, string, string];
      assert.deepEqual([kind, text], ['steer', 'more']);
      useStore.getState().markPendingFailed(id, 'dropped');
      useStore.setState({ observability: { ...useStore.getState().observability, turnStatus: 'idle' } });
      sessionController.retrySend(id);
      assert.deepEqual(sent.at(-1), ['prompt', [{ type: 'text', text: 'more' }], undefined, false]);
    } finally {
      (sessionController as Any).socket = null;
    }
  });
});

describe('the composer while a turn runs', () => {
  it('sends typed text into the turn, and keeps Stop', async () => {
    const { Composer } = await import('../web/src/components/chat/Composer.js');
    const original = sessionController.steer;
    const steered: string[] = [];
    sessionController.steer = (t: string) => void steered.push(t);
    try {
      useStore.setState({ activeId: 'c1', chatId: 'c1', observability: { ...useStore.getState().observability, turnStatus: 'running', compacting: false } });
      render(createElement(Composer, { chatId: 'c1', connStatus: 'connected' }));
      assert.equal(host.querySelector('[aria-label="Send to the running turn"]'), null, 'nothing to send yet');
      const input = host.querySelector('textarea.composer-input') as HTMLTextAreaElement;
      act(() => {
        Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Also do X');
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
      });
      assert.ok(host.querySelector('[aria-label="Stop"]'));
      await act(async () => {
        (host.querySelector('[aria-label="Send to the running turn"]') as HTMLElement).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      });
      assert.deepEqual(steered, ['Also do X']);
      assert.equal(input.value, '');
    } finally {
      sessionController.steer = original;
    }
  });
});
