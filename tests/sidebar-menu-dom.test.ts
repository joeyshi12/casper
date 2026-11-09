// Portalling a row's menu to body moves the pointer off the row, so :hover drops and the
// hover-only ⋮ fades out while its menu is still open; an is-menu-open class holds the state.
// jsdom applies no stylesheet, so this proves the wiring, not the appearance.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSummary } from '@casper/shared';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let Sidebar: Any;
let MemoryRouter: Any;
let root: Any;
let host: HTMLElement;
let w: Any;
const calls: string[] = [];

const now = new Date().toISOString();
const sessions = [
  { chatId: 's1', title: 'first', cwd: '/tmp', createdAt: '', updatedAt: now, liveness: 'dormant', running: false, pinned: true },
  { chatId: 's2', title: 'second', cwd: '/tmp', createdAt: '', updatedAt: now, liveness: 'dormant', running: false, pinned: false },
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
  ({ window: w, host, react: { createElement, act } } = await installDomGlobals([
    'localStorage', 'history', 'location',
  ]));
  ({ createRoot } = await import('react-dom/client'));
  ({ MemoryRouter } = await import('react-router'));
  ({ Sidebar } = await import('../web/src/components/layout/Sidebar.js'));
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  calls.length = 0;
  w.localStorage.clear();
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
          onNew: () => calls.push('new'),
          onDelete: () => {},
          onRename: () => {},
          onPin: (id: string, pinned: boolean) => calls.push(`pin:${id}:${pinned}`),
          onLock: () => calls.push('lock'),
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

describe('sidebar sections (rendered in a DOM)', () => {
  const buttonNamed = (name: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name) as HTMLElement;

  const sectionNames = () =>
    [...host.querySelectorAll('.sidebar-section')].map((el) => el.getAttribute('aria-label'));
  const rowsIn = (name: string) =>
    [...host.querySelectorAll(`.sidebar-section[aria-label="${name}"] .srow-title`)].map((t) => t.textContent);

  it('scrolls the nav and the chats together, under a fixed header', () => {
    const aside = host.querySelector('aside.sidebar')!;
    assert.deepEqual([...aside.children].map((el) => el.className), ['sidebar-head', 'sidebar-scroll']);
    assert.deepEqual(
      [...host.querySelectorAll('.sidebar-nav button')].map((b) => b.textContent?.trim()),
      ['New', 'Search', 'Settings'],
    );
  });

  it('draws a line under the header only while the list is scrolled down', () => {
    const scroller = host.querySelector('.sidebar-scroll') as HTMLElement;
    const head = host.querySelector('.sidebar-head')!;
    const scrollTo = (top: number) =>
      act(() => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new w.Event('scroll'));
      });
    assert.ok(!head.classList.contains('is-scrolled'));
    scrollTo(40);
    assert.ok(head.classList.contains('is-scrolled'));
    scrollTo(0);
    assert.ok(!head.classList.contains('is-scrolled'));
  });

  it('shows pinned chats in their own section above the rest', () => {
    assert.deepEqual(sectionNames(), ['Pinned', 'Chats']);
    assert.deepEqual(rowsIn('Pinned'), ['first']);
    assert.deepEqual(rowsIn('Chats'), ['second']);
  });

  it('groups the unpinned chats by date, and remembers the choice', () => {
    click(buttonNamed('Group chats by date'));
    assert.deepEqual(sectionNames(), ['Pinned', 'Today']);
    assert.deepEqual(rowsIn('Today'), ['second']);
    assert.equal(w.localStorage.getItem('casper.groupChatsByDate'), '1');
    assert.ok(host.querySelector('.sidebar-section[aria-label="Today"] [aria-label="Group chats by date"]'));
    click(buttonNamed('Group chats by date'));
    assert.deepEqual(sectionNames(), ['Pinned', 'Chats']);
  });

  it('folds a section away from its heading', () => {
    const toggle = host.querySelector('.sidebar-section[aria-label="Pinned"] .sidebar-section-toggle')!;
    click(toggle);
    assert.deepEqual(rowsIn('Pinned'), []);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    click(toggle);
    assert.deepEqual(rowsIn('Pinned'), ['first']);
  });

  it('pins and unpins from the row menu', () => {
    click(menuButtons()[1]!);
    click([...w.document.querySelectorAll('.menu-item')].find((b: Element) => b.textContent === 'Pin')!);
    click(menuButtons()[0]!);
    click([...w.document.querySelectorAll('.menu-item')].find((b: Element) => b.textContent === 'Unpin')!);
    assert.deepEqual(calls, ['pin:s2:true', 'pin:s1:false']);
  });

  it('shows each session by its title alone', () => {
    assert.deepEqual(rows().map((r) => r.querySelector('.srow-open')?.textContent), ['first', 'second']);
  });

  it('wires each control', () => {
    click(buttonNamed('New'));
    assert.deepEqual(calls, ['new']);
    click(buttonNamed('Search'));
    assert.ok(w.document.querySelector('.search-modal'), 'search opens');
  });
});

describe('the settings dialog (rendered in a DOM)', () => {
  it('opens from the sidebar with its sections, and saves a default', async () => {
    const { api } = await import('../web/src/api/rest.js');
    const { useStore } = await import('../web/src/state/store.js');
    const original = {
      settings: api.settings,
      updateDefaults: api.updateDefaults,
      models: api.models,
      agents: api.agents,
      tools: api.tools,
      setMcpServerDisabled: api.setMcpServerDisabled,
      devices: api.devices,
    };
    const saved: unknown[] = [];
    Object.assign(api, {
      settings: async () => ({
        defaultAgentId: 'casper',
        server: { version: '1.2.3', kiroVersion: 'kiro-cli 3.1.0', kiroBin: '/bin/kiro-cli', host: '0.0.0.0', port: 4319, authEnabled: true, fileRoot: '/', defaultCwd: '/w', dataDir: '/d', configFile: '/c.json', maxLiveSessions: 6, liveSessions: 1, uptimeMs: 90_000 },
      }),
      updateDefaults: async (b: unknown) => (saved.push(b), { ok: true }),
      models: async () => ({ models: [] }),
      agents: async () => ({ agents: [], defaultAgentId: 'casper' }),
      tools: async () => ({
        mcpServers: [{ name: 'figma', command: 'npx', args: ['-y', 'figma'], envKeys: ['FIGMA_API_KEY'], disabled: false }],
        skills: [{ name: 'grilling', description: 'Grill the user.', path: '/k/skills/grilling/SKILL.md' }],
      }),
      setMcpServerDisabled: async (...a: unknown[]) => (saved.push(['mcp', ...a]), { ok: true }),
      devices: async () => ({
        devices: [
          { id: 'd1', current: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/156', createdAt: '', lastSeenAt: new Date().toISOString() },
          { id: 'd2', current: false, userAgent: 'Mozilla/5.0 (iPhone) Safari/1', createdAt: '', lastSeenAt: new Date().toISOString() },
        ],
      }),
    });
    useStore.setState({
      models: [{ modelId: 'opus', modelName: 'Opus', description: '', contextWindowTokens: 1, rateMultiplier: 2, rateUnit: 'Credit', isDefault: true, effortLevels: ['low', 'high'], defaultEffort: 'low' }],
      agents: [{ id: 'casper', name: 'casper' }, { id: 'vibe', name: 'Default' }],
    });
    try {
      await act(async () => {
        [...host.querySelectorAll('.sidebar-nav button')].find((b) => b.textContent?.trim() === 'Settings')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      });
      const dialog = () => w.document.querySelector('.settings-modal') as HTMLElement;
      assert.deepEqual([...dialog().querySelectorAll('[role="tab"]')].map((t) => t.textContent), ['General', 'Tools', 'Account', 'About']);
      assert.deepEqual(
        [...dialog().querySelectorAll('.settings-item-name')].map((l) => l.textContent),
        ['Model', 'Effort', 'Agent'],
      );
      // Pick High in the effort menu.
      const effort = dialog().querySelector('[aria-label="Default effort"]') as HTMLElement;
      await act(async () => effort.dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      const high = [...dialog().querySelectorAll('.dd-option')].find((o) => o.textContent?.includes('High')) as HTMLElement;
      await act(async () => high.dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      assert.deepEqual(saved, [{ effort: { modelId: 'opus', level: 'high' } }]);

      const tab = (name: string) => [...dialog().querySelectorAll('[role="tab"]')].find((t) => t.textContent === name) as HTMLElement;
      await act(async () => tab('About').dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      assert.match(dialog().textContent ?? '', /1\.2\.3/);
      assert.match(dialog().textContent ?? '', /Running for1m 30s/);
      assert.deepEqual(
        [...dialog().querySelectorAll('.settings-card')].map((c) => c.getAttribute('aria-label')),
        ['Versions', 'Server', 'Folders'],
      );
      await act(async () => tab('Tools').dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      const cards = [...dialog().querySelectorAll('.settings-card')];
      assert.deepEqual(cards.map((c) => c.getAttribute('aria-label')), ['MCP servers', 'Skills'], 'no powers');
      assert.match(cards[0]!.textContent ?? '', /figmastdionpx -y figmaenv: FIGMA_API_KEY/);
      assert.match(cards[1]!.textContent ?? '', /grillingGrill the user\./);
      const use = dialog().querySelector('[aria-label="Use figma"]') as HTMLInputElement;
      assert.equal(use.checked, true);
      await act(async () => use.click());
      assert.deepEqual(saved.at(-1), ['mcp', 'figma', true]);
      await act(async () => tab('Account').dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      assert.match(dialog().textContent ?? '', /Linux · ChromeThis device/);
      assert.match(dialog().textContent ?? '', /iOS · Safari/);
      assert.deepEqual(
        [...dialog().querySelectorAll('.settings-card')].map((c) => c.getAttribute('aria-label')),
        ['Logged-in devices', 'This browser'],
      );
      assert.equal(w.document.querySelectorAll('[role="dialog"]').length, 1, 'no tab opens another dialog');
      const lock = [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Lock') as HTMLElement;
      await act(async () => lock.dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      assert.deepEqual(calls, ['lock']);
      assert.equal(w.document.querySelector('.settings-modal'), null, 'locking closes the dialog');
    } finally {
      Object.assign(api, original);
    }
  });
});
