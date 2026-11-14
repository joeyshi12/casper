// A choice usually renders while the turn that asked it is still running. A click then sent
// a prompt the server refused with "A turn is already running for this session".

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let ChoiceTemplate: Any;
let useStore: Any;
let sessionController: Any;
let root: Any;
let host: HTMLElement;
let sent: unknown[];
let answered: [string, string][];

const data = {
  question: 'Which one?',
  options: [
    { label: 'First', prompt: 'Take the first' },
    { label: 'Second', prompt: 'Take the second' },
  ],
};

const buttons = () => [...host.querySelectorAll('button.tpl-choice-opt')] as HTMLButtonElement[];

const setTurnStatus = (turnStatus: string) => {
  act(() => {
    useStore.setState((s: Any) => ({ observability: { ...s.observability, turnStatus } }));
  });
};

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  ({ createRoot } = await import('react-dom/client'));
  ({ ChoiceTemplate } = await import('../web/src/components/chat/ChoiceTemplate.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
  ({ sessionController } = await import('../web/src/state/sessionController.js'));
  sessionController.send = (content: unknown) => sent.push(content);
  sessionController.answerChoice = (toolCallId: string, answer: string) => {
    answered.push([toolCallId, answer]);
    return true;
  };
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  sent = [];
  answered = [];
  useStore.getState().clearActive();
  useStore.setState({ activeId: 's1', items: [] });
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(createElement(ChoiceTemplate, { data, tool: { id: 'choice-1', content: [] } }));
  });
});

describe('choice buttons and the running turn', () => {
  it('are disabled and send nothing while the turn is running', () => {
    setTurnStatus('running');
    assert.deepEqual(buttons().map((b) => b.disabled), [true, true]);
    act(() => buttons()[0]!.click());
    assert.equal(sent.length, 0);
    assert.equal(host.querySelector('.is-picked'), null);
  });

  it('become usable once the turn ends, and send the picked option', () => {
    setTurnStatus('running');
    setTurnStatus('idle');
    assert.deepEqual(buttons().map((b) => b.disabled), [false, false]);
    act(() => buttons()[1]!.click());
    assert.deepEqual(sent, [[{ type: 'text', text: 'Take the second' }]]);
    assert.equal(host.querySelector('.is-picked')?.textContent, 'Second');
  });

  it('stay disabled while the conversation is being compacted', () => {
    act(() => {
      useStore.setState((s: Any) => ({ observability: { ...s.observability, compacting: true } }));
    });
    assert.deepEqual(buttons().map((b) => b.disabled), [true, true]);
  });
});

describe('a choice the running turn waits on', () => {
  const render = (tool: Any) => {
    act(() => root.render(createElement(ChoiceTemplate, { data, tool: { id: 'choice-1', content: [], ...tool } })));
  };
  const setWaiting = (waitingChoice: string | undefined) => {
    act(() => {
      useStore.setState((s: Any) => ({ observability: { ...s.observability, turnStatus: 'running', waitingChoice } }));
    });
  };

  it('can be answered while the turn runs, and answers the call rather than sending a prompt', () => {
    setWaiting('choice-1');
    assert.deepEqual(buttons().map((b) => b.disabled), [false, false]);
    act(() => buttons()[0]!.click());
    assert.deepEqual(answered, [['choice-1', 'Take the first']]);
    assert.equal(sent.length, 0);
    assert.equal(host.querySelector('.is-picked')?.textContent, 'First');
  });

  it('stays disabled while the turn waits on a different call', () => {
    setWaiting('choice-2');
    assert.deepEqual(buttons().map((b) => b.disabled), [true, true]);
  });

  it("shows the pick read back from the call's result after a reload", () => {
    setWaiting(undefined);
    render({ status: 'completed', content: [{ type: 'text', text: 'The user answered: Take the second' }] });
    assert.equal(host.querySelector('.is-picked')?.textContent, 'Second');
    render({ status: 'completed', output: { response: 'The user answered: Take the second', message: '' } });
    assert.equal(host.querySelector('.is-picked')?.textContent, 'Second');
  });

  it('closes without a pick when the user typed something else', () => {
    setWaiting(undefined);
    useStore.setState((s: Any) => ({ observability: { ...s.observability, turnStatus: 'idle' } }));
    render({ status: 'completed', content: [{ type: 'text', text: 'The user answered: A grid instead' }] });
    assert.equal(host.querySelector('.is-picked'), null);
    assert.deepEqual(buttons().map((b) => b.disabled), [true, true]);
    assert.equal(host.querySelector('.tpl-choice-reply .msg-user-text')?.textContent, 'A grid instead');
  });

  it('shows no reply under the card for a tapped option', () => {
    render({ status: 'completed', content: [{ type: 'text', text: 'The user answered: Take the second' }] });
    assert.equal(host.querySelector('.tpl-choice-reply'), null);
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
