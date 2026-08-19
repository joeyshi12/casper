// The widget frame, exercised in a real DOM.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, requestInterceptor } from 'jsdom';
import { buildWidgetShell, WIDGET_CDNS } from '../web/src/components/chat/widgetShell.js';
import { sendWidgetPrompt } from '../web/src/state/sessionController.js';
import { useStore } from '../web/src/state/store.js';

/** The shell in a real DOM, driven over postMessage exactly as WidgetBlock drives it. */
function mountWidget() {
  const dom = new JSDOM(buildWidgetShell(), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { __out: unknown[] }).__out = [];
      window.postMessage = ((msg: unknown) => {
        (window as unknown as { __out: unknown[] }).__out.push(msg);
      }) as typeof window.postMessage;
    },
  });
  const win = dom.window as unknown as {
    __out: { type: string; height?: number; text?: string }[];
    MessageEvent: typeof MessageEvent;
    document: Document;
    dispatchEvent(e: Event): boolean;
    close(): void;
    casper: { sendPrompt(t: string): void };
  };
  const send = (data: unknown) => {
    const ev = new win.MessageEvent('message', { data });
    Object.defineProperty(ev, 'source', { value: dom.window });
    win.dispatchEvent(ev);
  };
  return { win, send, root: () => win.document.getElementById('root')! };
}

describe('widget shell', () => {
  const shell = buildWidgetShell();

  it('sandboxes with a CDN allowlist rather than letting scripts load anywhere', () => {
    const csp = /content="([^"]*)"/.exec(shell)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    for (const cdn of WIDGET_CDNS) assert.ok(csp.includes(cdn), `${cdn} missing`);
    // No same-origin escape hatch, and nothing may be sent off to arbitrary hosts.
    assert.ok(!csp.includes("connect-src *"));
  });

  it('gives the runtime a mount point and the bridge', () => {
    assert.match(shell, /<div id="root"><\/div>/);
    assert.match(shell, /sendPrompt/);
  });

});

describe('widget prompt bridge', () => {
  it('does nothing when there is no session to send into', () => {
    useStore.setState({ activeId: null, pending: [] });
    assert.equal(sendWidgetPrompt('hello'), false);
  });

  it('forwards trimmed text and caps the length', () => {
    // A widget only exists inside a session, and the bubble it produces is the
    // observable effect of the bridge.
    useStore.setState({ activeId: 's1', pending: [] });
    assert.equal(sendWidgetPrompt('  hi  '), true);
    assert.equal(sendWidgetPrompt('x'.repeat(5000)), true);
    assert.equal(sendWidgetPrompt('   '), false);
    assert.deepEqual(
      useStore.getState().pending.map((p) => p.text),
      ['hi', 'x'.repeat(4000)],
    );
    useStore.setState({ activeId: null, pending: [] });
  });
});

describe('widget runtime', () => {
  it('renders streamed html', () => {
    const { win, send, root } = mountWidget();
    send({ type: 'casper:html', html: '<p class="a">hello</p>' });
    assert.match(root().innerHTML, /hello/);
    win.close();
  });

  it('measures height from the content, not the frame it was given', () => {
    const { win, send, root } = mountWidget();
    // jsdom has no layout. The frame is 120px until the host is told otherwise, so a
    // document-based measurement reports that and the content overflows - which is
    // exactly the scrollbar this replaced.
    Object.defineProperty(win.document.documentElement, 'scrollHeight', {
      value: 120,
      configurable: true,
    });
    Object.defineProperty(root(), 'scrollHeight', { value: 940, configurable: true });
    send({ type: 'casper:html', html: '<p>tall</p>' });
    const height = win.__out.find((m) => m.type === 'casper:height')?.height;
    // 940 of content plus two pixels of slack for fractional layout.
    assert.equal(height, 942);
    win.close();
  });

  it('runs a script once, and not again on a repeat of the same content', () => {
    const { win, send } = mountWidget();
    const html = '<div>x</div><script>window.__ran = (window.__ran || 0) + 1;</script>';
    send({ type: 'casper:html', html });
    assert.equal((win as unknown as { __ran?: number }).__ran, 1);
    // A second identical post must not wipe the nodes the script is driving.
    send({ type: 'casper:html', html });
    assert.equal((win as unknown as { __ran?: number }).__ran, 1);
    win.close();
  });

  it('exposes sendPrompt, and refuses empty text', () => {
    const { win } = mountWidget();
    win.casper.sendPrompt('   ');
    assert.equal(win.__out.filter((m) => m.type === 'casper:prompt').length, 0);
    win.casper.sendPrompt('do the thing');
    const sent = win.__out.find((m) => m.type === 'casper:prompt');
    assert.equal(sent?.text, 'do the thing');
    win.close();
  });

  it('ignores messages that did not come from its host', () => {
    const { win, root } = mountWidget();
    const ev = new win.MessageEvent('message', {
      data: { type: 'casper:html', html: '<p>injected</p>' },
    });
    Object.defineProperty(ev, 'source', { value: null });
    win.dispatchEvent(ev);
    assert.equal(root().innerHTML, '');
    win.close();
  });
});

describe('widget external scripts', () => {
  /**
   * Narrower than it looks: it proves a widget can pull in a library and use it, not
   * that the runtime waits. jsdom sequences dynamic scripts itself, so it passes either
   * way - the structural check below is what guards that.
   */
  it('can load a library and use it from its own script', async () => {
    const dom = new JSDOM(buildWidgetShell(), {
      runScripts: 'dangerously',
      url: 'https://widget.test/',
      resources: {
        interceptors: [
          requestInterceptor((request: Request) =>
            request.url.endsWith('/lib.js')
              ? new Response('window.Chart = function () {};', {
                  headers: { 'Content-Type': 'application/javascript' },
                })
              : undefined,
          ),
        ],
      },
      beforeParse(window) {
        window.postMessage = (() => {}) as typeof window.postMessage;
      },
    });
    const win = dom.window as unknown as {
      MessageEvent: typeof MessageEvent;
      dispatchEvent(e: Event): boolean;
      close(): void;
      __seen?: string;
    };

    const html =
      '<div>chart</div>' +
      '<script src="https://widget.test/lib.js"><' + '/script>' +
      '<script>window.__seen = typeof window.Chart;<' + '/script>';
    const ev = new win.MessageEvent('message', {
      data: { type: 'casper:html', html },
    });
    Object.defineProperty(ev, 'source', { value: dom.window });
    win.dispatchEvent(ev);

    // Nothing yet: the inline script has to wait for the library.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(win.__seen, 'function', 'library was not available to the inline script');
    win.close();
  });
});

describe('widget script sequencing', () => {
  // Structural, because behaviour can't be observed in jsdom. Real browsers do not
  // block on a dynamically inserted script, which is how a widget got
  // "Chart is not defined": the library was still in flight when its own code ran.
  const runtime = () => {
    const shell = buildWidgetShell();
    // One script block now: the runtime. morphdom used to be the first.
    return /<script>([\s\S]*?)<\/script>/.exec(shell)?.[1] ?? '';
  };

  it('waits for a script with a src before running the next one', () => {
    const source = runtime();
    assert.match(source, /onload = advance/, 'external scripts are not awaited');
    assert.match(source, /onerror = advance/, 'a failed script would stall the rest');
    assert.match(source, /async = false/);
  });

  it('caps the wait, so a CDN that never answers does not strand the widget', () => {
    assert.match(runtime(), /setTimeout\(advance, \d+\)/);
  });

  it('runs inline scripts without waiting', () => {
    assert.match(runtime(), /if \(!external\) next\(\);/);
  });
});
