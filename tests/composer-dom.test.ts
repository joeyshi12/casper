// Run with: npm test
//
// The composer's attach button used to be disabled for a draft, because uploads were keyed by
// kiro's session id and a draft has none. A chat id exists from the moment the draft opens, so
// the button has to work there - and a unit test of the upload path would not have caught the
// disabled attribute that actually blocked it.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let Composer: Any;
let useStore: Any;
let root: Any;
let host: HTMLElement;

const plusButton = () =>
  host.querySelector('button[aria-label="Add photos and files"]') as HTMLButtonElement;

const mount = (props: Record<string, unknown>) => {
  act(() => {
    root = createRoot(host);
    root.render(
      createElement(Composer, {
        chatId: 'c0ffee00-0000-4000-8000-000000000000',
        onSend: () => {},
        onCancel: () => {},
        onCompact: () => {},
        onChangeModel: () => {},
        onChangeAgent: () => {},
        connStatus: 'connected',
        ...props,
      }),
    );
  });
};

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://casper.test/',
  });
  const w = dom.window as Any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const g = globalThis as Any;
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'matchMedia', 'DocumentFragment', 'DataTransfer', 'File',
  ]) {
    g[key] = w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  g.React = react.default ?? react;
  ({ createElement, act } = react);
  ({ createRoot } = await import('react-dom/client'));
  ({ Composer } = await import('../web/src/components/chat/Composer.js'));
  ({ useStore } = await import('../web/src/state/store.js'));

  host = w.document.getElementById('host');
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  useStore.getState().clearActive();
  act(() => root?.unmount());
  root = null;
});

describe('attaching a file to a first prompt', () => {
  it('leaves the attach button usable in a draft', () => {
    mount({ draft: true, connStatus: 'connecting' });
    const plus = plusButton();
    assert.ok(plus, 'the attach button is rendered');
    assert.equal(plus.disabled, false, 'a draft can attach: its chat id already exists');
    assert.equal(plus.title, 'Add photos & files', 'and says so, rather than asking to send first');
  });

  it('leaves it usable in an open session', () => {
    mount({ draft: false });
    assert.equal(plusButton().disabled, false);
  });

  // A draft is deliberately treated as live, since sending is what creates the session. A real
  // session that has lost its socket has nowhere to upload, so it stays disabled.
  it('disables it when a live session is not connected', () => {
    mount({ draft: false, connStatus: 'connecting' });
    assert.equal(plusButton().disabled, true);
  });
});
