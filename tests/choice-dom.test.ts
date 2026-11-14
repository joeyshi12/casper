// The show_choice call the turn waits on shows its options in a panel above the composer,
// and the transcript keeps a record of what was answered.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let ChoicePanel: Any;
let ChoiceTemplate: Any;
let ToolCallCard: Any;
let useStore: Any;
let sessionController: Any;
let root: Any;
let host: HTMLElement;
let answered: [string, string][];
let skipped: string[];

const input = {
  lead_in: 'Both **fit** the page.',
  question: 'Which one?',
  options: [
    { label: 'First', prompt: 'Take the first', detail: 'The plain one' },
    { label: 'Second', prompt: 'Take the second' },
  ],
};
const choiceTool = (extra: Any = {}) => ({
  id: 'choice-1', name: 'casper/show_choice', title: '@casper/show_choice', status: 'in_progress', content: [], input, ...extra,
});

const options = () => [...host.querySelectorAll('button.choice-panel-opt')] as HTMLButtonElement[];
const setWaiting = (waitingChoice: string | undefined, tool: Any = choiceTool()) => {
  act(() => {
    useStore.setState((s: Any) => ({
      items: [{ type: 'tool_call', tool }],
      observability: { ...s.observability, turnStatus: waitingChoice ? 'running' : 'idle', waitingChoice },
    }));
  });
};
const show = (el: Any) => act(() => root.render(el));

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  // MarkdownRenderer preloads katex when idle, which jsdom cannot import; skip it.
  (globalThis as Any).requestIdleCallback = () => {};
  ({ createRoot } = await import('react-dom/client'));
  ({ ChoicePanel } = await import('../web/src/components/chat/ChoicePanel.js'));
  ({ ChoiceTemplate } = await import('../web/src/components/chat/ChoiceTemplate.js'));
  ({ ToolCallCard } = await import('../web/src/components/chat/ToolCallCard.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
  ({ sessionController } = await import('../web/src/state/sessionController.js'));
  sessionController.answerChoice = (toolCallId: string, answer: string) => {
    answered.push([toolCallId, answer]);
    return true;
  };
  sessionController.skipChoice = (toolCallId: string) => {
    skipped.push(toolCallId);
    return true;
  };
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  answered = [];
  skipped = [];
  useStore.getState().clearActive();
  useStore.setState({ activeId: 's1', items: [] });
  act(() => {
    root?.unmount();
    root = createRoot(host);
  });
});

describe('the choice panel above the composer', () => {
  it('shows the waiting question with numbered options, and a tap answers the call', () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    assert.equal(host.querySelector('.choice-panel-q')?.textContent, 'Which one?');
    assert.deepEqual(options().map((b) => b.querySelector('.choice-panel-num')?.textContent), ['1', '2']);
    assert.equal(options()[0]!.querySelector('.choice-panel-detail')?.textContent, 'The plain one');
    act(() => options()[1]!.click());
    assert.deepEqual(answered, [['choice-1', 'Take the second']]);
    assert.deepEqual(options().map((b) => b.disabled), [true, true], 'one answer per question');
  });

  it("answers with an option's number key, and skips with Escape", () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));
    assert.deepEqual(answered, [['choice-1', 'Take the first']]);

    setWaiting('choice-2', choiceTool({ id: 'choice-2' }));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.deepEqual(skipped, ['choice-2']);
  });

  it('sends what is typed in "Something else", and Skip when nothing is typed', () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    const field = host.querySelector('.choice-panel-input') as HTMLInputElement;
    const action = () => host.querySelector('.choice-panel-skip') as HTMLButtonElement;
    assert.equal(action().textContent, 'Skip');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
      setter.call(field, 'A grid');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(action().textContent, 'Send');
    act(() => action().click());
    assert.deepEqual(answered, [['choice-1', 'A grid']]);
    assert.deepEqual(skipped, []);
  });

  it('closes with the close button as a skip', () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    act(() => (host.querySelector('.choice-panel-close') as HTMLButtonElement).click());
    assert.deepEqual(skipped, ['choice-1']);
  });

  it('is not shown when no question is waiting', () => {
    setWaiting(undefined);
    show(createElement(ChoicePanel));
    assert.equal(host.querySelector('.choice-panel'), null);
  });
});

describe('the choice in the transcript', () => {
  const data = { leadIn: '', question: 'Which one?', options: input.options };
  const record = (tool: Any) => show(createElement(ChoiceTemplate, { data, tool: { id: 'choice-1', content: [], ...tool } }));

  it('shows nothing while the turn waits on it, since the panel has the options', () => {
    setWaiting('choice-1');
    record({ status: 'in_progress' });
    assert.equal(host.innerHTML, '');
  });

  it("shows a tapped option's label as the user's answer, read from the result", () => {
    setWaiting(undefined);
    record({ status: 'completed', content: [{ type: 'text', text: 'The user answered: Take the second' }] });
    assert.equal(host.querySelector('.msg-user .msg-user-text')?.textContent, 'Second');
    record({ status: 'completed', output: { response: 'The user answered: Take the second', message: '' } });
    assert.equal(host.querySelector('.msg-user .msg-user-text')?.textContent, 'Second');
  });

  it('shows a typed answer as written', () => {
    setWaiting(undefined);
    record({ status: 'completed', content: [{ type: 'text', text: 'The user answered: A grid instead' }] });
    assert.equal(host.querySelector('.msg-user .msg-user-text')?.textContent, 'A grid instead');
  });

  it('says when the question was skipped', () => {
    setWaiting(undefined);
    record({ status: 'completed', content: [{ type: 'text', text: 'The user skipped the question. Carry on.' }] });
    assert.equal(host.querySelector('.tpl-choice-closed')?.textContent, 'Skipped: Which one?');
  });

  it('renders the lead_in as reply text above it', () => {
    setWaiting('choice-1');
    show(createElement(ToolCallCard, { tool: choiceTool() }));
    const lead = host.querySelector('.msg-assistant');
    assert.equal(lead?.textContent?.trim(), 'Both fit the page.');
    assert.equal(lead?.querySelector('strong')?.textContent, 'fit');
  });
});

describe('choice events in the store', () => {
  const event = (seq: number, payload: Any) => ({ seq, ts: seq, chatId: 's1', payload });

  it('marks the waiting call, then clears it and drops the typed message that answered it', () => {
    useStore.setState({ appliedSeq: 0, pending: [{ id: 'pending-3', text: 'A grid', content: [], steer: true }] } as Any);
    useStore.getState().applyEvent(event(1, { kind: 'choice_waiting', toolCallId: 'choice-1' }));
    assert.equal(useStore.getState().observability.waitingChoice, 'choice-1');
    useStore.getState().applyEvent(event(2, { kind: 'choice_settled', toolCallId: 'choice-1', answer: 'A grid', clientId: 'pending-3' }));
    assert.equal(useStore.getState().observability.waitingChoice, undefined);
    assert.deepEqual(useStore.getState().pending, []);
  });
});
