// The show_choice call the turn waits on asks its questions one at a time in a panel above
// the composer, and the transcript keeps a card of what was answered.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { encodeChoiceAnswers, formatChoiceAnswers, formatChoiceReply, formatChoiceSkipped } from '@casper/shared';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let ChoicePanel: Any;
let ToolCallCard: Any;
let useStore: Any;
let sessionController: Any;
let root: Any;
let host: HTMLElement;
let answered: [string, string][];
let skipped: string[];

const layout = { question: 'Which layout?', options: [{ label: 'One column', prompt: 'Use one column' }, { label: 'Two columns' }] };
const width = { question: 'How wide?', options: [{ label: 'Narrow' }, { label: 'Wide' }] };
const input = (questions: Any[]) => ({ lead_in: 'Both **fit** the page.', questions });
const choiceTool = (extra: Any = {}, questions: Any[] = [layout, width]) => ({
  id: 'choice-1', name: 'casper/show_choice', title: '@casper/show_choice', status: 'in_progress', content: [],
  input: input(questions), ...extra,
});

const options = () => [...host.querySelectorAll('button.choice-panel-opt')] as HTMLButtonElement[];
const question = () => host.querySelector('.choice-panel-q')?.textContent;
const key = (k: string) => act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
const setWaiting = (waitingChoice: string | undefined, tool: Any = choiceTool()) => {
  act(() => {
    useStore.setState((s: Any) => ({
      items: [{ type: 'tool_call', tool }],
      observability: { ...s.observability, turnStatus: waitingChoice ? 'running' : 'idle', waitingChoice },
    }));
  });
};
const show = (el: Any) => act(() => root.render(el));
const type = (text: string) => {
  const field = host.querySelector('.choice-panel-input') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  // MarkdownRenderer preloads katex when idle, which jsdom cannot import; skip it.
  (globalThis as Any).requestIdleCallback = () => {};
  ({ createRoot } = await import('react-dom/client'));
  ({ ChoicePanel } = await import('../web/src/components/chat/ChoicePanel.js'));
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
  it('asks the questions in turn, then answers the call with all of them', () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    assert.equal(question(), 'Which layout?');
    assert.equal(host.querySelector('.choice-panel-step')?.textContent, '1 of 2');
    assert.deepEqual(options().map((b) => b.querySelector('.choice-panel-num')?.textContent), ['1', '2']);
    act(() => options()[0]!.click());
    assert.deepEqual(answered, [], 'nothing is sent until the last question');
    assert.equal(question(), 'How wide?');
    assert.equal(host.querySelector('.choice-panel-step')?.textContent, '2 of 2');
    act(() => options()[1]!.click());
    assert.deepEqual(answered, [['choice-1', encodeChoiceAnswers(['Use one column', 'Wide'])]]);
    assert.deepEqual(options().map((b) => b.disabled), [true, true], 'one answer per call');
  });

  it('answers with number keys, and Escape skips the current question', () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    key('Escape');
    assert.equal(question(), 'How wide?');
    key('1');
    assert.deepEqual(answered, [['choice-1', encodeChoiceAnswers([null, 'Narrow'])]]);
  });

  it('skips the call when every question was skipped', () => {
    setWaiting('choice-1');
    show(createElement(ChoicePanel));
    act(() => (host.querySelector('.choice-panel-skip') as HTMLButtonElement).click());
    act(() => (host.querySelector('.choice-panel-skip') as HTMLButtonElement).click());
    assert.deepEqual(skipped, ['choice-1']);
    assert.deepEqual(answered, []);
  });

  it('takes a typed answer from "Something else"', () => {
    setWaiting('choice-1', choiceTool({}, [layout]));
    show(createElement(ChoicePanel));
    assert.equal(host.querySelector('.choice-panel-step'), null, 'no counter for one question');
    const action = () => host.querySelector('.choice-panel-skip') as HTMLButtonElement;
    assert.equal(action().textContent, 'Skip');
    type('A grid');
    assert.equal(action().textContent, 'Send');
    act(() => action().click());
    assert.deepEqual(answered, [['choice-1', encodeChoiceAnswers(['A grid'])]]);
  });

  it('skips the whole call with the close button', () => {
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
  const card = (extra: Any) => show(createElement(ToolCallCard, { tool: choiceTool({ status: 'completed', ...extra }) }));
  const rows = () =>
    [...host.querySelectorAll('.tpl-choice-row')].map((r) => [
      r.querySelector('.tpl-choice-q')?.textContent,
      r.querySelector('.tpl-choice-a')?.textContent,
    ]);
  const result = (text: string) => ({ content: [{ type: 'text', text }] });

  it('shows the lead-in and nothing else while the turn waits on it', () => {
    setWaiting('choice-1');
    show(createElement(ToolCallCard, { tool: choiceTool() }));
    const lead = host.querySelector('.msg-assistant');
    assert.equal(lead?.textContent?.trim(), 'Both fit the page.');
    assert.equal(lead?.querySelector('strong')?.textContent, 'fit');
    assert.equal(host.querySelector('.tpl-choice-record'), null);
  });

  it('shows each question with its answer, by option label, read from the result', () => {
    setWaiting(undefined);
    card(result(formatChoiceAnswers(['Which layout?', 'How wide?'], ['Use one column', null])));
    assert.deepEqual(rows(), [['Which layout?', 'One column'], ['How wide?', 'Skipped']]);
    card({ output: { response: formatChoiceAnswers(['Which layout?', 'How wide?'], ['A grid', 'Wide']), message: '' } });
    assert.deepEqual(rows(), [['Which layout?', 'A grid'], ['How wide?', 'Wide']]);
  });

  it('shows a reply typed instead of answering under the questions', () => {
    setWaiting(undefined);
    card(result(formatChoiceReply('Neither, a grid')));
    assert.deepEqual(rows(), [['Which layout? How wide?', 'Neither, a grid']]);
  });

  it('marks every question skipped, or not answered when the turn stopped', () => {
    setWaiting(undefined);
    card(result(formatChoiceSkipped()));
    assert.deepEqual(rows(), [['Which layout?', 'Skipped'], ['How wide?', 'Skipped']]);
    card(result('The questions were closed without an answer.'));
    assert.deepEqual(rows(), [['Which layout?', 'Not answered'], ['How wide?', 'Not answered']]);
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
