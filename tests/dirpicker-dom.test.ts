//
// The old field carried the whole path in one input and offered its suggestions to the
// mouse only. This covers the two things that replaced it: browsing by breadcrumb, and
// the combobox keyboard contract from the WAI-ARIA APG. It also covers the sheet's
// dismissal, where dragging a selection past the edge used to close it and lose the input.
//
// The directory listing is a stub, so this says nothing about the server's own splitting
// of a path into directory and prefix - only that the client asks for the right thing and
// renders what comes back.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { DirListing } from '@casper/shared';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let DirectoryPicker: Any;
let ChangeFolderSheet: Any;
let api: Any;
let root: Any;
let host: HTMLElement;
let w: Any;

/** Directories the stubbed endpoint knows about. */
const tree: Record<string, string[]> = {
  '/home': ['joey'],
  '/home/joey': ['projects', 'Documents'],
  '/home/joey/projects': ['casper', 'code-search', 'pql-parser'],
  '/home/joey/projects/casper': ['server', 'web'],
};

/** Stands in for GET /api/fs/dirs, including its dir/prefix split. */
const listDirs = (q: string): Promise<DirListing> => {
  const endsWithSep = q.endsWith('/');
  const resolved = endsWithSep ? q.replace(/\/+$/, '') : q;
  const dir = endsWithSep ? resolved : resolved.slice(0, resolved.lastIndexOf('/')) || '/';
  const prefix = endsWithSep ? '' : resolved.slice(resolved.lastIndexOf('/') + 1);
  const names = (tree[dir] ?? []).filter((n) =>
    n.toLowerCase().startsWith(prefix.toLowerCase()),
  );
  const target = endsWithSep ? resolved : q;
  return Promise.resolve({
    dir,
    entries: names.map((n) => `${dir}/${n}`),
    target,
    targetKind: tree[target] ? 'directory' : 'missing',
  } as DirListing);
};

const requested: string[] = [];
let responded = 0;

const crumbs = () =>
  [...host.querySelectorAll('.dirpick-crumb:not(.dirpick-more)')] as HTMLElement[];
const input = () => host.querySelector('.dirpick-input') as HTMLInputElement;
const listbox = () => host.querySelector('[role="listbox"]') as HTMLElement;
const more = () => host.querySelector('.dirpick-more') as HTMLElement | null;
const opts = () => [...host.querySelectorAll('[role="option"]')] as HTMLElement[];
const status = () => host.querySelector('.dirpick-status') as HTMLElement;

/**
 * Wait out the picker's own 150ms debounce, then poll until every request it made has been
 * answered. Only the fixed part is a constant of ours; the waiting polls, so a slow box
 * makes this take longer rather than fail.
 */
const settle = async (timeoutMs = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    if (Date.now() - started > 180 && responded === requested.length) return;
  }
  assert.fail('the directory listing never settled');
};

/**
 * Type into the input. React patches a value tracker onto the element and treats a
 * directly assigned `.value` as a no-op, so go through the native setter it shadowed.
 */
const type = async (text: string) => {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  await settle();
};

const key = async (k: string, opts_: Record<string, unknown> = {}) => {
  await act(async () => {
    input().dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts_ }));
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
  for (const k of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'matchMedia', 'DocumentFragment',
  ]) {
    g[k] = w[k];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  g.React = react.default ?? react;
  ({ createElement, act } = react);
  ({ createRoot } = await import('react-dom/client'));
  ({ DirectoryPicker } = await import('../web/src/components/sessions/DirectoryPicker.js'));
  ({ ChangeFolderSheet } = await import('../web/src/components/sessions/ChangeFolderSheet.js'));
  ({ api } = await import('../web/src/api/rest.js'));

  api.listDirs = (q: string) => {
    requested.push(q);
    return listDirs(q).then((r) => {
      responded++;
      return r;
    });
  };

  host = w.document.getElementById('host');
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  requested.length = 0;
  responded = 0;
  act(() => {
    root?.unmount();
    root = createRoot(host);
  });
});

const mountPicker = async (initialPath: string, onChange: Any = () => {}) => {
  await act(async () => {
    root.render(createElement(DirectoryPicker, { initialPath, onChange }));
  });
  await settle();
};

describe('DirectoryPicker (rendered in a DOM)', () => {
  it('lists the starting folder rather than making you type it', async () => {
    await mountPicker('/home/joey/projects');
    // A trailing slash is what asks the server for everything inside.
    assert.equal(requested[0], '/home/joey/projects/');
    assert.deepEqual(
      opts().map((o) => o.textContent),
      ['casper', 'code-search', 'pql-parser'],
    );
  });

  it('shows names under a breadcrumb, not repeated absolute paths', async () => {
    await mountPicker('/home/joey/projects');
    assert.deepEqual(crumbs().map((c) => c.textContent), ['/', 'home', 'joey', 'projects']);
    // The old field put the whole path in every row; the name carries it now.
    assert.ok(!opts()[0]!.textContent!.includes('/'), 'an option is a name, not a path');
  });

  it('does not print a separator after the root, which read as "/ /"', async () => {
    await mountPicker('/home/joey/projects');
    const row = host.querySelector('.dirpick-crumbs') as HTMLElement;
    // Root is itself "/", so the separators belong between the named segments only.
    assert.equal(row.querySelectorAll('.dirpick-sep').length, crumbs().length - 2);
    assert.ok(!row.textContent!.startsWith('//'), row.textContent!);
  });

  // There is no separate up button: the parent is always one of the visible crumbs, so a
  // dedicated control duplicated it and took a touch target's worth of room to do so.
  it('has no up button, because the parent crumb is always shown', async () => {
    await mountPicker('/home/joey/projects');
    assert.equal(host.querySelector('.dirpick-up'), null);

    const parent = crumbs().find((c) => c.textContent === 'joey')!;
    assert.ok(parent, 'the parent is right there in the trail');
    await act(async () => {
      parent.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.deepEqual(opts().map((o) => o.textContent), ['projects', 'Documents']);
  });

  it('drills in on click, and the breadcrumb follows', async () => {
    await mountPicker('/home/joey/projects');
    await act(async () => {
      opts()[0]!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    await settle();

    // Four segments deep, so the middle folds away: root, overflow, parent, current.
    assert.deepEqual(crumbs().map((c) => c.textContent), ['/', 'projects', 'casper']);
    assert.ok(more(), 'and the folded ancestors are behind a counted button');
    assert.deepEqual(opts().map((o) => o.textContent), ['server', 'web']);
  });

  it('climbs back up when a visible breadcrumb is clicked', async () => {
    await mountPicker('/home/joey/projects/casper');
    // crumbs are [/, projects, casper]; the parent is the one to click.
    const parent = crumbs().find((c) => c.textContent === 'projects')!;
    await act(async () => {
      parent.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.deepEqual(opts().map((o) => o.textContent), ['casper', 'code-search', 'pql-parser']);
  });

  // A sideways swipe that runs off the end of a horizontal scroller chains to the page and
  // fires the browser's back gesture, so the trail is a fixed set with no scroller at all.
  it('folds the middle of a deep path instead of scrolling it', async () => {
    await mountPicker('/home/joey/projects/casper');
    assert.deepEqual(crumbs().map((c) => c.textContent), ['/', 'projects', 'casper']);
    assert.ok(more()!.querySelector('svg'), 'an SVG ellipsis, not a squeezed monospace glyph');
    assert.equal(
      more()!.getAttribute('aria-label'),
      'Show 2 folders above',
      'the count lives in the accessible name rather than in the glyph',
    );
  });

  it('leaves a shallow path alone rather than folding one crumb behind a button', async () => {
    await mountPicker('/home/joey/projects');
    assert.deepEqual(crumbs().map((c) => c.textContent), ['/', 'home', 'joey', 'projects']);
    assert.equal(more(), null, 'nothing to gain from folding a single crumb');
  });

  it('reaches a folded ancestor through the overflow menu', async () => {
    await mountPicker('/home/joey/projects/casper');
    await act(async () => {
      more()!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    const menu = w.document.body.querySelector('.menu-list-floating') as HTMLElement;
    assert.ok(menu, 'the menu opens');
    assert.deepEqual(
      [...menu.querySelectorAll('.menu-item')].map((b) => b.textContent),
      ['home', 'joey'],
    );

    await act(async () => {
      (menu.querySelector('.menu-item') as HTMLElement).dispatchEvent(
        new w.MouseEvent('click', { bubbles: true }),
      );
    });
    await settle();
    assert.deepEqual(opts().map((o) => o.textContent), ['joey']);
  });

  it('filters within the current folder instead of holding the path', async () => {
    await mountPicker('/home/joey/projects');
    await type('co');
    assert.equal(requested.at(-1), '/home/joey/projects/co');
    assert.deepEqual(opts().map((o) => o.textContent), ['code-search']);
  });

  it('takes a pasted absolute path without rewriting it under the cursor', async () => {
    await mountPicker('/home/joey');
    await type('/home/joey/projects/pql');
    assert.equal(input().value, '/home/joey/projects/pql', 'what was typed stays put');
    assert.equal(requested.at(-1), '/home/joey/projects/pql');
    assert.deepEqual(opts().map((o) => o.textContent), ['pql-parser']);
  });

  it('reports the resolved target as it moves', async () => {
    const seen: string[] = [];
    await mountPicker('/home/joey/projects', (p: string) => seen.push(p));
    assert.equal(seen.at(-1), '/home/joey/projects');
    await type('newthing');
    assert.equal(seen.at(-1), '/home/joey/projects/newthing');
    assert.match(host.textContent!, /will be created/);
  });

  it('moves through options with the arrow keys, which the old field could not', async () => {
    await mountPicker('/home/joey/projects');
    assert.equal(input().getAttribute('aria-activedescendant'), null);

    await key('ArrowDown');
    assert.equal(opts()[0]!.getAttribute('aria-selected'), 'true');
    assert.equal(input().getAttribute('aria-activedescendant'), opts()[0]!.id);

    await key('ArrowDown');
    assert.equal(opts()[1]!.getAttribute('aria-selected'), 'true');
    await key('ArrowUp');
    assert.equal(opts()[0]!.getAttribute('aria-selected'), 'true');
  });

  it('enters the highlighted option on Enter', async () => {
    await mountPicker('/home/joey/projects');
    await key('ArrowDown');
    await key('Enter');
    await settle();
    assert.deepEqual(opts().map((o) => o.textContent), ['server', 'web']);
  });

  it('submits on Enter when nothing is highlighted', async () => {
    let submits = 0;
    await act(async () => {
      root.render(
        createElement(DirectoryPicker, {
          initialPath: '/home/joey/projects',
          onChange: () => {},
          onSubmit: () => submits++,
        }),
      );
    });
    await settle();
    await key('Enter');
    assert.equal(submits, 1);
  });

  it('goes up a level on ArrowLeft from an empty filter', async () => {
    await mountPicker('/home/joey/projects');
    await key('ArrowLeft');
    await settle();
    assert.deepEqual(opts().map((o) => o.textContent), ['projects', 'Documents']);
  });

  it('carries the combobox roles the pattern requires', async () => {
    await mountPicker('/home/joey/projects');
    const el = input();
    assert.equal(el.getAttribute('role'), 'combobox');
    assert.equal(el.getAttribute('aria-autocomplete'), 'list');
    assert.equal(el.getAttribute('aria-controls'), listbox().id);
    // The listbox is a permanent part of the sheet, so it is expanded whenever it has
    // anything in it - hiding it was what made the sheet jump.
    assert.equal(el.getAttribute('aria-expanded'), 'true');
  });

  // The sheet used to resize on every navigation, and again when the input lost focus.
  it('keeps the same structure whatever a folder contains', async () => {
    const shape = () => ({
      list: Boolean(host.querySelector('.dirpick-list')),
      status: Boolean(host.querySelector('.dirpick-status')),
    });

    await mountPicker('/home/joey/projects'); // three children
    const withThree = shape();

    await act(async () => {
      opts()[0]!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    await settle(); // casper: two children
    assert.deepEqual(shape(), withThree, 'same parts after navigating');

    await type('nomatchatall'); // zero options
    assert.deepEqual(shape(), withThree, 'the list stays, with an empty state inside it');
    assert.ok(host.querySelector('.dirpick-empty'), 'and says so');
    assert.equal(opts().length, 0);
  });

  it('keeps the status line in the layout whether or not it says anything', async () => {
    await mountPicker('/home/joey/projects');
    assert.ok(status(), 'present, and empty, on an existing folder');
    assert.equal(status().textContent, '');

    await type('brandnewfolder');
    assert.match(status().textContent!, /will be created/);
    assert.ok(status(), 'same row, so nothing below it moves when the notice appears');
  });

  // Focusing on open raised the on-screen keyboard over the sheet before you had chosen to
  // type anything, and the list is the thing to look at first.
  it('clears the highlight when the filter changes', async () => {
    await mountPicker('/home/joey/projects');
    await key('ArrowDown');
    assert.equal(opts()[0]!.getAttribute('aria-selected'), 'true');

    // Enter during the debounce would otherwise take the previous listing's active row.
    await type('co');
    assert.equal(input().getAttribute('aria-activedescendant'), null);
  });

  it('leaves Escape to the sheet when nothing is highlighted', async () => {
    await mountPicker('/home/joey/projects');
    let bubbled = 0;
    w.document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') bubbled++;
    });

    await key('Escape');
    assert.equal(bubbled, 1, 'reaches the document, so the sheet can close');

    await key('ArrowDown');
    await key('Escape');
    assert.equal(bubbled, 1, 'swallowed only while a row is highlighted');
    assert.equal(input().getAttribute('aria-activedescendant'), null, 'and clears it');
  });

  it('does not take focus when it opens', async () => {
    await mountPicker('/home/joey/projects');
    assert.equal(input().hasAttribute('autofocus'), false);
    assert.notEqual(w.document.activeElement, input());
  });

  it('drops the chrome the sheet heading already provides', async () => {
    await mountPicker('/home/joey/projects');
    // No visible label, no second path readout, no static hint - the breadcrumb and the
    // input carry all of it.
    assert.equal(host.querySelector('.picker-label'), null);
    assert.equal(host.querySelector('.dirpick-target'), null);
    assert.ok(!host.textContent!.includes('keeps its transcript'));
    // Still named for a screen reader, though.
    assert.equal(input().getAttribute('aria-label'), 'Working directory');
  });

  it('wraps path text so the CSS can elide the front of it', async () => {
    await mountPicker('/home/joey/projects');
    // Front-elision is `direction: rtl` on the outer element with the text in an inner
    // LTR span. jsdom applies no stylesheet, so only the structure it keys off is
    // checkable here; that it looks right needs a browser.
    assert.ok(host.querySelector('.dirpick-tail > span'), 'each option has its inner span');
  });
});

describe('ChangeFolderSheet dismissal (rendered in a DOM)', () => {
  const mountSheet = async (onClose: Any) => {
    await act(async () => {
      root.render(
        createElement(ChangeFolderSheet, {
          sessionId: 's1',
          currentCwd: '/home/joey/projects',
          onChanged: () => {},
          onClose,
        }),
      );
    });
    await settle();
  };

  const backdrop = () => host.querySelector('.sheet-backdrop') as HTMLElement;
  const sheet = () => host.querySelector('.sheet') as HTMLElement;

  const press = (el: Element) =>
    el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));

  it('closes on a click that starts and ends on the backdrop', async () => {
    let closed = 0;
    await mountSheet(() => closed++);
    await act(async () => {
      press(backdrop());
      backdrop().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(closed, 1);
  });

  it('survives a selection dragged out of the sheet and released outside', async () => {
    let closed = 0;
    await mountSheet(() => closed++);
    // The press begins in the input; the release lands past the sheet, so the browser
    // raises the click on their common ancestor - the backdrop.
    await act(async () => {
      press(input());
      backdrop().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(closed, 0, 'a drag out of the input must not close the sheet');
  });

  it('ignores a click that began outside and finished on the sheet', async () => {
    let closed = 0;
    await mountSheet(() => closed++);
    await act(async () => {
      press(backdrop());
      sheet().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(closed, 0);
  });

  it('closes on Escape', async () => {
    let closed = 0;
    await mountSheet(() => closed++);
    await act(async () => {
      w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.equal(closed, 1);
  });
});
