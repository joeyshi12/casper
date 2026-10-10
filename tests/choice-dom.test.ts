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
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  sent = [];
  useStore.getState().clearActive();
  useStore.setState({ activeId: 's1', items: [] });
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(createElement(ChoiceTemplate, { data, toolId: 'choice-1' }));
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
