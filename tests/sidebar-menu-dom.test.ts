//
// Portalling a row's menu to body moves the pointer off the row, so :hover drops and the
// hover-only ⋮ fades out while its menu is still open; an is-menu-open class holds the state.
// jsdom applies no stylesheet, so this proves the wiring, not the appearance.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ChatSummary } from '@casper/shared';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let Sidebar: Any;
let MemoryRouter: Any;
let root: Any;
let host: HTMLElement;
let w: Any;

const sessions = [
  { chatId: 's1', title: 'first', cwd: '/tmp', createdAt: '', updatedAt: '', liveness: 'dormant', running: false },
  { chatId: 's2', title: 'second', cwd: '/tmp', createdAt: '', updatedAt: '', liveness: 'dormant', running: false },
] as unknown as ChatSummary[];

const rows = () => [...host.querySelectorAll('.srow')] as HTMLElement[];
const menuButtons = () =>
  [...host.querySelectorAll('button[aria-label="Session actions"]')] as HTMLElement[];
const openMenu = () => w.document.body.querySelector('.menu-list-floating');

const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  });
};

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://casper.test/',
  });
  w = dom.window as Any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const g = globalThis as Any;
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'matchMedia', 'DocumentFragment', 'localStorage', 'history',
    'location',
  ]) {
    if (w[key] !== undefined) g[key] = w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  g.React = react.default ?? react;
  ({ createElement, act } = react);
  ({ createRoot } = await import('react-dom/client'));
  ({ MemoryRouter } = await import('react-router'));
  ({ Sidebar } = await import('../web/src/components/layout/Sidebar.js'));

  host = w.document.getElementById('host');
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(Sidebar, {
          sessions,
          activeId: 's2',
          loadingId: null,
          onOpen: () => {},
          onNew: () => {},
          onDelete: () => {},
          onRename: () => {},
          onLock: () => {},
        }),
      ),
    );
  });
});

describe('session row with its menu open (rendered in a DOM)', () => {
  it('renders a row per session, and no menu until one is asked for', () => {
    assert.equal(rows().length, 2);
    assert.equal(openMenu(), null);
  });

  it('holds the hover state on the row while its menu is open', () => {
    assert.ok(!rows()[0]!.className.includes('is-menu-open'), 'not set to begin with');

    click(menuButtons()[0]!);

    assert.ok(openMenu(), 'the menu opened');
    assert.ok(
      rows()[0]!.className.includes('is-menu-open'),
      'the row keeps its highlight even though the pointer left it',
    );
  });

  it('marks only the row whose menu is open', () => {
    click(menuButtons()[0]!);
    assert.ok(rows()[0]!.className.includes('is-menu-open'));
    assert.ok(!rows()[1]!.className.includes('is-menu-open'), 'the other row is untouched');
  });

  it('keeps is-active and is-menu-open together, so the active row steps up too', () => {
    // s2 is the active session; its button gets the stronger fill via both classes.
    click(menuButtons()[1]!);
    const row = rows()[1]!;
    assert.ok(row.className.includes('is-active'));
    assert.ok(row.className.includes('is-menu-open'));
  });

  it('drops the state when the menu closes', () => {
    click(menuButtons()[0]!);
    assert.ok(rows()[0]!.className.includes('is-menu-open'));

    act(() => {
      w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    });

    assert.equal(openMenu(), null, 'the menu closed');
    assert.ok(!rows()[0]!.className.includes('is-menu-open'), 'and the row released it');
  });
});
