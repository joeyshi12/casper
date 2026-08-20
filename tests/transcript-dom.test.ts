// Run with: npm test
//
// The unit tests for TranscriptViewport drive it directly, with three numbers standing in
// for a scroll container. They prove the state machine and say nothing about whether the
// component is actually plumbed into it: a scroll handler wired to nothing, or flags that
// never reach React, would leave every one of them passing.
//
// This renders the real component in a DOM and drives it through the DOM. jsdom computes no
// layout, so the geometry is defined on the element by hand - that is a fake, but the wiring
// either side of it is real.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { TranscriptItem } from '@casper/shared';

// The DOM globals and React internals here are untyped by nature; one alias keeps the
// casts honest rather than scattered.
type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let Transcript: Any;
let useStore: Any;
let api: Any;
let root: Any;
let host: HTMLElement;

/** Geometry jsdom will not compute for us. */
const fakeGeometry = (el: Element, scrollHeight: number, clientHeight: number) => {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
};

const scrollTo = (el: Element, top: number) => {
  (el as HTMLElement).scrollTop = top;
  act(() => {
    el.dispatchEvent(new (globalThis as Any).Event('scroll', { bubbles: false }));
  });
};

const transcript = () => host.querySelector('.transcript') as HTMLElement;
const latestButton = () => host.querySelector('button[aria-label="Scroll to latest"]');
const olderRow = () => host.querySelector('.loading-older');

const userMessages = (n: number): TranscriptItem[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'message',
    message: { id: `u-${i}`, role: 'user', text: `message ${i}` },
  })) as TranscriptItem[];

before(async () => {
  // The DOM has to exist before the module is imported: Transcript reads
  // window.matchMedia at module scope to decide whether to ease or snap.
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true, // gives requestAnimationFrame
    url: 'https://casper.test/',
  });
  const w = dom.window as Any;
  // jsdom implements no matchMedia at all.
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const g = globalThis as Any;
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'matchMedia', 'DocumentFragment',
  ]) {
    g[key] = w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  // tsx compiles JSX with the classic runtime here - run from the repo root it never reads
  // web/tsconfig.json, so `jsx: react-jsx` doesn't apply and the components' JSX becomes
  // React.createElement calls with no React import in scope. Supply it as a global.
  g.React = react.default ?? react;
  ({ createElement, act } = react);
  ({ createRoot } = await import('react-dom/client'));
  ({ Transcript } = await import('../web/src/components/chat/Transcript.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
  ({ api } = await import('../web/src/api/rest.js'));

  host = w.document.getElementById('host');
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  useStore.getState().clearActive();
  useStore.setState({ activeId: 's1', items: userMessages(12), remainingOlder: 0 });
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(createElement(Transcript, { onRetry: () => {}, onRetryTurn: () => {} }));
  });
});

describe('transcript wiring (rendered in a DOM)', () => {
  it('mounts and renders the messages it is given', () => {
    assert.ok(transcript(), 'the scroll container exists');
    assert.equal(host.querySelectorAll('.msg-user').length, 12);
  });

  // Proves the chain: DOM scroll event -> viewport.onScroll -> onFlags -> setState -> render.
  it('a scroll away from the bottom reveals the jump-to-latest button', () => {
    assert.equal(latestButton(), null, 'hidden while at the bottom');

    fakeGeometry(transcript(), 4000, 600);
    scrollTo(transcript(), 0); // 3400px from the bottom, well past the threshold

    assert.ok(latestButton(), 'the button appears once the user is far from the bottom');
  });

  // Proves the button's onClick reaches viewport.jumpToLatest, which clears the flag.
  it('tapping the button hides it again', () => {
    fakeGeometry(transcript(), 4000, 600);
    scrollTo(transcript(), 0);
    const button = latestButton() as HTMLElement;

    act(() => button.dispatchEvent(new (globalThis as Any).MouseEvent('click', { bubbles: true })));

    assert.equal(latestButton(), null, 'jumping to the latest hides the button');
  });

  // Proves the load-older wiring: the same scroll handler, the page fetch, and the flag
  // that renders the spinner row.
  it('scrolling to the top asks for an older page and says so', async () => {
    const asked: Array<[string, number, number]> = [];
    const original = api.transcriptPage;
    api.transcriptPage = async (id: string, offset: number, limit: number) => {
      asked.push([id, offset, limit]);
      return { items: [] };
    };
    try {
      act(() => useStore.setState({ remainingOlder: 200 }));
      fakeGeometry(transcript(), 4000, 600);

      await act(async () => {
        (transcript() as HTMLElement).scrollTop = 100; // inside the 300px trigger
        transcript().dispatchEvent(new (globalThis as Any).Event('scroll'));
      });

      assert.deepEqual(asked, [['s1', 120, 80]], 'asked for the page adjacent to the window');
    } finally {
      api.transcriptPage = original;
    }
  });

  it('shows the loading row while a page is in flight', async () => {
    let release: ((v: { items: TranscriptItem[] }) => void) | undefined;
    const original = api.transcriptPage;
    api.transcriptPage = () => new Promise((r) => (release = r));
    try {
      act(() => useStore.setState({ remainingOlder: 200 }));
      fakeGeometry(transcript(), 4000, 600);
      scrollTo(transcript(), 100);

      assert.ok(olderRow(), 'the row appears while the fetch is in flight');

      await act(async () => {
        release?.({ items: [] });
      });
      assert.equal(olderRow(), null, 'and goes once the page lands');
    } finally {
      api.transcriptPage = original;
    }
  });

  // Proves the reset effect is wired to activeId, not just present in the module.
  it('switching sessions clears the button', () => {
    fakeGeometry(transcript(), 4000, 600);
    scrollTo(transcript(), 0);
    assert.ok(latestButton(), 'shown for the first session');

    act(() => {
      useStore.setState({ activeId: 's2', items: userMessages(3), remainingOlder: 0 });
    });

    assert.equal(latestButton(), null, 'a new session starts clean');
  });
});
