// The connection status in the chat header shows only when the socket is not connected.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDomGlobals } from './helpers.js';

type Any = any;
let createElement: Any;
let act: Any;
let root: Any;
let host: HTMLElement;
let ConnDot: Any;

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  const { createRoot } = await import('react-dom/client');
  ({ ConnDot } = await import('../web/src/components/common/ConnBanner.js'));
  act(() => {
    root = createRoot(host);
  });
});

after(() => act(() => root.unmount()));

describe('the connection status', () => {
  const show = (status: string) => {
    act(() => root.render(createElement(ConnDot, { status })));
    return host.querySelector('.conndot-label')?.textContent ?? null;
  };

  it('shows nothing while connected', () => {
    assert.equal(show('connected'), null);
    assert.equal(host.innerHTML, '');
  });

  it('names every other state', () => {
    assert.equal(show('reconnecting'), 'Reconnecting');
    assert.equal(show('closed'), 'Offline');
    assert.equal(show('replaying'), 'Catching up');
  });
});
