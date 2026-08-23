//
// PopoverMenu portals to body and positions from the trigger's rect, so it cannot add to the
// sidebar list's scroll height or open past the bottom of the window. jsdom computes no
// layout, so both rects are defined by hand: the portal target, the flip decision and the
// dismissal are real, the geometry is not.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let PopoverMenu: Any;
let root: Any;
let host: HTMLElement;
let w: Any;

const VIEWPORT_H = 800;
const MENU_H = 90;
const MENU_W = 140;

/** Give an element the rect jsdom will not compute. */
const fakeRect = (el: Element, r: { top: number; bottom: number; right: number; width: number }) => {
  (el as Any).getBoundingClientRect = () => ({
    top: r.top,
    bottom: r.bottom,
    left: r.right - r.width,
    right: r.right,
    width: r.width,
    height: r.bottom - r.top,
  });
};

const menu = () => w.document.body.querySelector('.menu-list-floating') as HTMLElement;

/**
 * Mount the popover with a trigger placed at `anchorTop`. The menu's own height has to be
 * faked before the layout effect measures it, so the anchor is rendered first and the
 * menu's rect is stubbed via the prototype for the one class it applies to.
 */
const mountAt = (anchorTop: number) => {
  act(() => {
    root?.unmount();
    root = createRoot(host);
  });
  const trigger = w.document.createElement('button');
  host.appendChild(trigger);
  fakeRect(trigger, { top: anchorTop, bottom: anchorTop + 28, right: 290, width: 28 });

  // Any element carrying the floating class reports the menu's size.
  const original = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList?.contains('menu-list-floating')) {
      return { top: 0, bottom: MENU_H, left: 0, right: MENU_W, width: MENU_W, height: MENU_H };
    }
    return original.call(this);
  };

  act(() => {
    root.render(
      createElement(
        PopoverMenu,
        { anchor: trigger, onClose: () => closed.push(true) },
        createElement('button', { className: 'menu-item' }, 'Rename'),
      ),
    );
  });
  w.Element.prototype.getBoundingClientRect = original;
  return trigger;
};

let closed: true[] = [];

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://casper.test/',
  });
  w = dom.window as Any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(w, 'innerHeight', { value: VIEWPORT_H, configurable: true });
  Object.defineProperty(w, 'innerWidth', { value: 1200, configurable: true });

  const g = globalThis as Any;
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'matchMedia', 'DocumentFragment',
  ]) {
    g[key] = w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  g.React = react.default ?? react;
  ({ createElement, act } = react);
  ({ createRoot } = await import('react-dom/client'));
  ({ PopoverMenu } = await import('../web/src/components/common/PopoverMenu.js'));

  host = w.document.getElementById('host');
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  closed = [];
  host.innerHTML = '';
});

describe('PopoverMenu (rendered in a DOM)', () => {
  it('renders into document.body, not inside the row that owns it', () => {
    mountAt(200);
    const el = menu();
    assert.ok(el, 'the menu is in the document');
    assert.equal(el.parentElement, w.document.body, 'portaled to body');
    assert.equal(host.querySelector('.menu-list-floating'), null, 'not inside the list');
  });

  it('opens below the trigger when there is room', () => {
    mountAt(200); // bottom 228, menu 90 tall, viewport 800 - fits
    assert.equal(menu().style.top, '234px', 'anchor bottom + 6px gap');
  });

  it('flips above the trigger when the menu would fall off the bottom', () => {
    // The last row: bottom 760, so 760 + 6 + 90 + 8 exceeds the 800px viewport.
    mountAt(732);
    assert.equal(menu().style.top, '636px', 'anchor top - 6px gap - 90px menu');
  });

  it('never positions itself off the top either', () => {
    // A trigger near the top with no room below cannot flip to a negative offset.
    Object.defineProperty(w, 'innerHeight', { value: 100, configurable: true });
    mountAt(40);
    Object.defineProperty(w, 'innerHeight', { value: VIEWPORT_H, configurable: true });
    assert.ok(Number.parseInt(menu().style.top, 10) >= 8, 'clamped to the 8px margin');
  });

  it('right-aligns to the trigger', () => {
    mountAt(200); // trigger right edge 290, menu 140 wide
    assert.equal(menu().style.left, '150px');
  });

  it('closes on Escape', () => {
    mountAt(200);
    act(() => {
      w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.deepEqual(closed, [true]);
  });

  it('closes on a click outside, but not on one inside itself', () => {
    mountAt(200);
    act(() => {
      menu().dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.deepEqual(closed, [], 'a click on the menu must not dismiss it');

    act(() => {
      w.document.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.deepEqual(closed, [true]);
  });

  it('closes when the list scrolls, since a fixed menu cannot follow its trigger', () => {
    mountAt(200);
    act(() => {
      host.dispatchEvent(new w.Event('scroll', { bubbles: false }));
    });
    assert.deepEqual(closed, [true]);
  });
});
