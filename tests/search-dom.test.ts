// Run with: npm test
//
// Sidebar rows are links, so their onOpen only marks the chat as loading. Search results are
// buttons: without a navigate the spinner was raised and nothing ever opened.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ChatSummary } from '@casper/shared';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let SearchModal: Any;
let sessionController: Any;
let useStore: Any;
let host: HTMLElement;
let w: Any;
let root: Any;

const navigated: string[] = [];

const chats = [
  { chatId: 'chat-alpha', title: 'Alpha', agentId: 'casper' },
  { chatId: 'chat-tailoring', title: 'Tailoring', agentId: 'casper' },
] as unknown as ChatSummary[];

const results = () => [...w.document.body.querySelectorAll('.search-result')] as HTMLElement[];

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://casper.test/',
  });
  w = dom.window as Any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const g = globalThis as Any;
  for (const k of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'matchMedia', 'DocumentFragment',
  ]) g[k] = w[k];
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  g.React = react.default ?? react;
  ({ createElement, act } = react);
  ({ createRoot } = await import('react-dom/client'));
  ({ SearchModal } = await import('../web/src/components/sessions/SearchModal.js'));
  ({ sessionController } = await import('../web/src/state/sessionController.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
  host = w.document.getElementById('host');
});

beforeEach(() => {
  navigated.length = 0;
  sessionController.attach({ navigate: (p: string) => navigated.push(p), onLock: () => {} });
  useStore.setState({ activeId: null, loadingChatId: null });
});

after(() => {
  act(() => root?.unmount());
});

describe('opening a chat from the search palette', () => {
  const mount = (onOpen: (id: string) => void = () => {}, onClose: () => void = () => {}) =>
    act(() => {
      root?.unmount();
      root = createRoot(host);
      root.render(createElement(SearchModal, { sessions: chats, onOpen, onClose }));
    });

  it('navigates to the chosen chat, not just marks it loading', () => {
    mount();
    const hit = results().find((b) => b.textContent?.includes('Tailoring'));
    assert.ok(hit, 'the palette lists the chat');
    act(() => hit.click());
    assert.deepEqual(navigated, ['/chats/chat-tailoring'], 'the route has to change');
  });

  it('still tells the parent, so the mobile drawer closes and the row shows a spinner', () => {
    const opened: string[] = [];
    let closed = 0;
    mount((id) => opened.push(id), () => closed++);
    const hit = results().find((b) => b.textContent?.includes('Alpha'));
    act(() => hit!.click());
    assert.deepEqual(opened, ['chat-alpha']);
    assert.equal(closed, 1, 'the palette closes');
    assert.deepEqual(navigated, ['/chats/chat-alpha']);
  });

  it('encodes the id it puts in the path', () => {
    mount();
    const odd = [{ chatId: 'a b/c', title: 'Odd', agentId: 'casper' }] as unknown as ChatSummary[];
    act(() => {
      root?.unmount();
      root = createRoot(host);
      root.render(createElement(SearchModal, { sessions: odd, onOpen: () => {}, onClose: () => {} }));
    });
    act(() => results()[0]!.click());
    assert.deepEqual(navigated, ['/chats/a%20b%2Fc']);
  });
});
