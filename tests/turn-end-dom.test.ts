// The cards that end an interrupted or failed turn, rendered in jsdom.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from '@casper/shared';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let TranscriptEntries: Any;
let groupToolCalls: Any;
let useStore: Any;
let sessionController: Any;
let root: Any;
let host: HTMLElement;
let sent: unknown[];

const user = (id: string, text: string): TranscriptItem =>
  ({ type: 'message', message: { id, role: 'user', text } }) as TranscriptItem;
const interrupted = (id: string): TranscriptItem => ({ type: 'turn_interrupted', id });
const failed = (id: string, message: string): TranscriptItem => ({ type: 'turn_error', id, message });

const STDERR = 'kiro-cli exited on SIGTERM: The application panicked (crashed).\nMessage: invalid conversation history';

const show = (items: TranscriptItem[], pending: unknown[] = []) => {
  act(() => {
    useStore.setState({ activeId: 's1', items, pending });
    root?.unmount();
    root = createRoot(host);
    root.render(
      createElement(TranscriptEntries, {
        entries: groupToolCalls(items),
        lastActive: false,
        chatId: 's1',
        onOpenFile: () => {},
      }),
    );
  });
};

const card = () => host.querySelector('.turn-end') as HTMLElement | null;
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label)) as
    | HTMLButtonElement
    | undefined;

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  ({ createRoot } = await import('react-dom/client'));
  ({ TranscriptEntries } = await import('../web/src/components/chat/TranscriptEntries.js'));
  ({ groupToolCalls } = await import('../web/src/util/toolGroups.js'));
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
});

describe('interrupted turn card', () => {
  const items = [user('u1', 'Fix the tests'), interrupted('int-1')];

  it('says the response was interrupted and offers Retry but no edit', () => {
    show(items);
    assert.match(card()!.textContent!, /Casper's response was interrupted/);
    assert.ok(button('Retry'));
    assert.ok(!button('Edit'), 'Edit is absent');
    assert.ok(!button('Details'), 'there is no error to show');
  });

  it('Retry sends the last prompt again', () => {
    show(items);
    act(() => button('Retry')!.click());
    assert.deepEqual(sent, [[{ type: 'text', text: 'Fix the tests' }]]);
  });

  it('goes away once the user sends the next message', () => {
    show([...items, user('u2', 'Skip that and run the other tests')]);
    assert.ok(card() === null, 'the card is removed');
  });

  it('goes away as soon as the next message is pending', () => {
    show(items, [{ id: 'p1', text: 'Try again', status: 'sending' }]);
    assert.ok(card() === null, 'the card is removed');
  });
});

describe('failed turn card', () => {
  const items = [user('u1', 'Fix the tests'), failed('err-1', STDERR)];
  const open = () => host.querySelector('.collapse')!.classList.contains('is-open');

  it('shows only the title, with the error folded', () => {
    show(items);
    assert.equal(card()!.querySelector('.turn-end-text')!.textContent, 'Turn failed');
    assert.equal(open(), false);
    assert.ok(button('Retry'));
  });

  it('Details opens the full error through the shared fold, and Hide details closes it', () => {
    show(items);
    act(() => button('Details')!.click());
    assert.equal(open(), true);
    assert.equal(host.querySelector('.turn-end-raw')!.textContent, STDERR);
    assert.ok(host.querySelector('.toolline-chevron.is-open'), 'chevron matches the tool call folds');
    act(() => button('Hide details')!.click());
    assert.equal(open(), false);
  });

  it('Retry sends the last prompt again', () => {
    show(items);
    act(() => button('Retry')!.click());
    assert.deepEqual(sent, [[{ type: 'text', text: 'Fix the tests' }]]);
  });

  it('stays after the next message, without Retry', () => {
    show([...items, user('u2', 'Skip it')]);
    assert.ok(card()!.classList.contains('is-settled'));
    assert.ok(!button('Retry'), 'Retry is absent');
    assert.ok(button('Details'), 'the error can still be read');
  });

  it('shows no Retry in a read-only conversation', () => {
    act(() => {
      useStore.setState({ activeId: 's1', items, pending: [] });
      root?.unmount();
      root = createRoot(host);
      root.render(
        createElement(TranscriptEntries, {
          entries: groupToolCalls(items),
          lastActive: false,
          chatId: 's1',
          onOpenFile: () => {},
          readOnly: true,
        }),
      );
    });
    assert.ok(!button('Retry'), 'Retry is absent');
  });
});
