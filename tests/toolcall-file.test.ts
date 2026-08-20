// Run with: npm test
//
// The filename above a read or write body, and whether it can open a preview. The rule is
// the server's: the session preview endpoint confines to the workspace, so a file outside
// it has no preview to offer and the name stays plain text.

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { workspaceRelative } from '../web/src/util/workspacePath.js';
import type { ToolCallView } from '../web/src/state/store.js';
import type { SessionSummary } from '@casper/shared';

describe('workspaceRelative', () => {
  const cwd = '/home/joey/workspace/casper';

  it('makes a path inside the workspace relative', () => {
    assert.equal(workspaceRelative(cwd, `${cwd}/server/src/app.ts`), 'server/src/app.ts');
  });

  it('refuses a path outside the workspace', () => {
    assert.equal(workspaceRelative(cwd, '/etc/passwd'), null);
    assert.equal(workspaceRelative(cwd, '/home/joey/other/file.ts'), null);
  });

  // /home/joey/workspace/casper-two must not look like a child of .../casper.
  it('does not treat a sibling with a shared prefix as inside', () => {
    assert.equal(workspaceRelative(cwd, `${cwd}-two/file.ts`), null);
  });

  it('the workspace itself is not a file', () => {
    assert.equal(workspaceRelative(cwd, cwd), null);
    assert.equal(workspaceRelative(cwd, `${cwd}/`), null);
  });

  it('collapses . and .. rather than handing them to the server', () => {
    assert.equal(workspaceRelative(cwd, `${cwd}/server/../web/src/App.tsx`), 'web/src/App.tsx');
    assert.equal(workspaceRelative(cwd, `${cwd}/../secrets.txt`), null);
  });

  it('passes a relative path through, which is what the file tree gives', () => {
    assert.equal(workspaceRelative(cwd, 'server/src/app.ts'), 'server/src/app.ts');
    assert.equal(workspaceRelative(cwd, './server/src/app.ts'), 'server/src/app.ts');
  });

  it('has nothing to say without a workspace', () => {
    assert.equal(workspaceRelative('', '/anywhere/file.ts'), null);
  });
});

describe('the file heading on a tool call (rendered in a DOM)', () => {
  const cwd = '/work/proj';
  let createElement: Any;
  let act: Any;
  let createRoot: Any;
  let ToolCallCard: Any;
  let useStore: Any;
  let host: HTMLElement;
  let root: Any;

  const writeCall = (path: string): ToolCallView =>
    ({
      id: 't1',
      title: 'write',
      name: 'write',
      status: 'completed',
      content: [],
      input: {
        __tool_use_purpose: 'a purpose that used to hide the filename',
        command: 'create',
        path,
        content: 'hello\n',
      },
    }) as unknown as ToolCallView;

  const readCall = (path: string): ToolCallView =>
    ({
      id: 't2',
      title: 'read',
      name: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file body\n' } }],
      input: {
        __tool_use_purpose: 'also a purpose',
        operations: [{ mode: 'Line', path }],
      },
    }) as unknown as ToolCallView;

  const render = (tool: ToolCallView) => {
    act(() => {
      root?.unmount();
      root = createRoot(host);
      root.render(createElement(ToolCallCard, { tool }));
    });
    // The body is collapsed by default; the heading lives in it.
    const header = host.querySelector('.toolcall-head') as HTMLElement | null;
    if (header) act(() => header.click());
  };

  const name = () => host.querySelector('.toolcall-file-name');

  before(async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
      pretendToBeVisual: true,
      url: 'https://casper.test/',
    });
    const w = dom.window as Any;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const g = globalThis as Any;
    for (const k of [
      'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
      'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
      'matchMedia', 'DocumentFragment',
    ]) g[k] = w[k];
    g.IS_REACT_ACT_ENVIRONMENT = true;

    const react = await import('react');
    g.React = react.default ?? react;
    ({ createElement, act } = react);
    ({ createRoot } = await import('react-dom/client'));
    ({ ToolCallCard } = await import('../web/src/components/chat/ToolCallCard.js'));
    ({ useStore } = await import('../web/src/state/store.js'));
    host = w.document.getElementById('host');
  });

  beforeEach(() => {
    useStore.getState().clearActive();
    useStore.setState({
      activeId: 's1',
      sessions: [{ sessionId: 's1', cwd } as unknown as SessionSummary],
      previewPath: null,
    });
  });

  // The purpose used to win outright, so the filename was never shown.
  it('shows the path even when the agent supplied a purpose', () => {
    render(writeCall(`${cwd}/src/app.ts`));
    assert.equal(name()?.textContent, 'src/app.ts', 'relative to the workspace');
  });

  it('clicking it opens the preview at the workspace-relative path', () => {
    render(writeCall(`${cwd}/src/app.ts`));
    act(() => (name() as HTMLElement).click());
    assert.equal(useStore.getState().previewPath, 'src/app.ts');
  });

  it('a read shows its file too', () => {
    render(readCall(`${cwd}/docs/notes.md`));
    assert.equal(name()?.textContent, 'docs/notes.md');
    act(() => (name() as HTMLElement).click());
    assert.equal(useStore.getState().previewPath, 'docs/notes.md');
  });

  it('a file outside the workspace is named but not clickable', () => {
    render(writeCall('/etc/hosts'));
    const el = name();
    assert.equal(el?.textContent, '/etc/hosts', 'the full path, since relative means nothing');
    assert.equal(el?.tagName, 'SPAN', 'plain text, not a button');
    act(() => (el as HTMLElement).click());
    assert.equal(useStore.getState().previewPath, null, 'nothing to preview');
  });
});

/* The DOM globals and React internals here are untyped by nature. */
type Any = any;
