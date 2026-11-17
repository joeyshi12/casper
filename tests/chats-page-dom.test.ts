// The sidebar lists the 30 most recent chats and links to the chats page, which lists all of
// them with search, an age filter and bulk delete.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSummary } from '@casper/shared';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let MemoryRouter: Any;
let Sidebar: Any;
let ChatsPage: Any;
let SIDEBAR_CHATS: number;
let sessionController: Any;
let root: Any;
let host: HTMLElement;
let w: Any;
let deleted: string[][];

const DAY = 86_400_000;
const chat = (i: number, extra: Partial<ChatSummary> = {}) =>
  ({
    chatId: `c${i}`,
    title: `chat ${i}`,
    cwd: '/work',
    createdAt: '',
    updatedAt: new Date(Date.now() - i * DAY).toISOString(),
    liveness: 'dormant',
    running: false,
    pinned: false,
    ...extra,
  }) as ChatSummary;

const render = (el: Any) =>
  act(() => {
    root.render(createElement(MemoryRouter, null, el));
  });
const click = (el: Element | null) => act(() => (el as HTMLElement).dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
const buttonNamed = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;
const filter = (label: string) => {
  click(host.querySelector('button[aria-label="Filter by age"]'));
  click([...w.document.body.querySelectorAll('.chats-age')].find((b: Any) => b.textContent === label) ?? null);
};
const titles = () => [...host.querySelectorAll('.chats-title')].map((t) => t.textContent);
const typeInto = (input: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, text);
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  });

before(async () => {
  ({ window: w, host, react: { createElement, act } } = await installDomGlobals(['localStorage', 'history', 'location']));
  ({ createRoot } = await import('react-dom/client'));
  ({ MemoryRouter } = await import('react-router'));
  ({ Sidebar, SIDEBAR_CHATS } = await import('../web/src/components/layout/Sidebar.js'));
  ({ ChatsPage } = await import('../web/src/components/layout/ChatsPage.js'));
  ({ sessionController } = await import('../web/src/state/sessionController.js'));
  sessionController.deleteChats = async (ids: string[]) => {
    deleted.push(ids);
    return ids.filter((id) => id === 'c2');
  };
});

after(() => act(() => root?.unmount()));

beforeEach(() => {
  deleted = [];
  w.localStorage.clear();
  act(() => {
    root?.unmount();
    root = createRoot(host);
  });
});

describe('the sidebar list', () => {
  const sidebar = (sessions: ChatSummary[], activeId: string | null = null) =>
    render(
      createElement(Sidebar, {
        sessions,
        activeId,
        loadingId: null,
        onOpen: () => {},
        onPrefetch: () => {},
        onNew: () => {},
        onViewAll: () => {},
        onDelete: () => {},
        onRename: () => {},
        onPin: () => {},
        onLock: () => {},
      }),
    );
  const rowTitles = () => [...host.querySelectorAll('.srow-title')].map((t) => t.textContent);

  it('shows the 30 most recent chats, every pinned one, and a link to all of them', () => {
    const chats = [chat(0, { pinned: true }), ...Array.from({ length: 40 }, (_, i) => chat(i + 1))];
    sidebar(chats);
    assert.equal(rowTitles().length, 1 + SIDEBAR_CHATS);
    assert.equal(SIDEBAR_CHATS, 30);
    const link = host.querySelector('a.sidebar-viewall');
    assert.equal(link?.textContent, 'View all');
    assert.equal(link?.getAttribute('href'), '/chats');
  });

  it('keeps the open chat listed when it is older than the ones shown', () => {
    sidebar(Array.from({ length: 40 }, (_, i) => chat(i)), 'c35');
    assert.ok(rowTitles().includes('chat 35'));
    assert.equal(rowTitles().length, SIDEBAR_CHATS + 1);
  });
});

describe('the chats page', () => {
  const chats = [chat(0, { title: 'Plotting FFT', running: true }), chat(2, { title: 'Pygame fonts' }), chat(10, { title: 'Old notes', cwd: '/home/fft' }), chat(40, { title: 'Ancient' })];
  const page = () => render(createElement(ChatsPage, { chats, navOpen: false, onToggleNav: () => {}, onNew: () => {} }));

  it('lists every chat, newest first, with when it was last active', () => {
    page();
    assert.deepEqual(titles(), ['Plotting FFT', 'Pygame fonts', 'Old notes', 'Ancient']);
    assert.equal(host.querySelector('.chats-time')?.textContent, 'Just now');
    assert.equal(host.querySelectorAll('.chats-running').length, 1);
  });

  it('filters by title or folder, and by how long the chat has been idle', () => {
    page();
    assert.equal(host.querySelector('.chats-heading')?.textContent, 'Chats');
    click(host.querySelector('button[aria-label="Search chats"]'));
    typeInto(host.querySelector('.chats-search input') as HTMLInputElement, 'fft');
    assert.deepEqual(titles(), ['Plotting FFT', 'Old notes'], 'the folder matches too');
    click(host.querySelector('button[aria-label="Close search"]'));
    assert.equal(titles().length, 4, 'closing the search clears it');
    filter('Idle a week or more');
    assert.deepEqual(titles(), ['Old notes', 'Ancient']);
    assert.ok(host.querySelector('button[aria-label="Filter by age"]')?.classList.contains('is-on'));
  });

  it('fades its scrollbar like the sidebar, and draws a line under the header once scrolled', () => {
    page();
    const scroller = host.querySelector('.chats-scroll') as HTMLElement;
    assert.ok(scroller.classList.contains('fade-scroll'));
    assert.ok(scroller.contains(host.querySelector('.chats-head')), 'the header sticks inside the scroller');
    scroller.scrollTop = 120;
    act(() => scroller.dispatchEvent(new w.Event('scroll', { bubbles: true })));
    assert.ok(scroller.classList.contains('is-scrolling'));
    assert.ok(host.querySelector('.chats-head')?.classList.contains('is-scrolled'));
  });

  it('selects chats and deletes them after confirming, keeping failures selected', async () => {
    page();
    click(buttonNamed('Select'));
    const rows = () => [...host.querySelectorAll('button.chats-row')];
    click(rows()[1]!);
    click(rows()[2]!);
    assert.equal(host.querySelector('.chats-count')?.textContent, '2 selected');
    click(buttonNamed('Delete'));
    assert.match(w.document.body.querySelector('.confirm-modal')?.getAttribute('aria-label') ?? '', /Delete 2 chats/);
    await act(async () => {
      [...w.document.body.querySelectorAll('.confirm-modal button')].find((b: Any) => b.textContent === 'Delete')!.click();
    });
    assert.deepEqual(deleted, [['c2', 'c10']]);
    assert.match(host.querySelector('.chats-error')?.textContent ?? '', /1 of 2/);
    assert.equal(host.querySelector('.chats-count')?.textContent, '1 selected');
  });

  it('deletes only selected chats the filter still lists', async () => {
    page();
    click(buttonNamed('Select'));
    const rows = () => [...host.querySelectorAll('button.chats-row')];
    click(rows()[1]!);
    click(rows()[3]!);
    filter('Idle a week or more');
    assert.equal(host.querySelector('.chats-count')?.textContent, '1 selected');
    click(buttonNamed('Delete'));
    await act(async () => {
      [...w.document.body.querySelectorAll('.confirm-modal button')].find((b: Any) => b.textContent === 'Delete')!.click();
    });
    assert.deepEqual(deleted, [['c40']]);
  });

  it('selects every listed chat at once, and only those', () => {
    page();
    filter('Idle a month or more');
    click(buttonNamed('Select'));
    click(buttonNamed('Select all 1'));
    assert.equal(host.querySelector('.chats-count')?.textContent, '1 selected');
    click(buttonNamed('Clear selection'));
    assert.equal(host.querySelector('.chats-count')?.textContent, '0 selected');
  });
});
