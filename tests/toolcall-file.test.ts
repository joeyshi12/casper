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
import type { ChatSummary } from '@casper/shared';

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
    const line = host.querySelector('.toolline') as HTMLElement | null;
    if (line) act(() => line.click());
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
      chats: [{ chatId: 's1', cwd } as unknown as ChatSummary],
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

// An image read starts closed with its image inside the fold, and disappears when the
// file no longer exists as an image.
describe('image read tool calls (rendered in a DOM)', () => {
  let createElement: Any;
  let act: Any;
  let createRoot: Any;
  let ToolCallCard: Any;
  let host: HTMLElement;
  let root: Any;

  // Each test uses its own path, since the existence check is cached per path.
  let imagePath = '';
  let headStatus = 200;
  let headType = 'image/png';
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const imageRead = (): ToolCallView =>
    ({
      id: 'i1',
      title: 'read',
      name: 'read',
      status: 'completed',
      content: [],
      input: { operations: [{ mode: 'Image', image_paths: [imagePath] }] },
    }) as unknown as ToolCallView;

  const textRead = (): ToolCallView =>
    ({
      id: 'i2',
      title: 'read',
      name: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file body\n' } }],
      input: { operations: [{ mode: 'Line', path: '/work/proj/notes.md' }] },
    }) as unknown as ToolCallView;

  const render = (tool: ToolCallView) =>
    act(() => {
      root?.unmount();
      root = createRoot(host);
      root.render(createElement(ToolCallCard, { tool }));
    });

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
    host = w.document.getElementById('host');
    g.fetch = async () => ({ ok: headStatus < 400, headers: { get: () => headType } });
  });

  let n = 0;
  const freshPath = (status: number, type = 'image/png') => {
    imagePath = `/work/proj/mascot-${n++}.png`;
    headStatus = status;
    headType = type;
  };

  it('starts closed, and opening it shows the image', async () => {
    freshPath(200);
    render(imageRead());
    await flush();
    const line = host.querySelector('.toolline') as HTMLElement;
    assert.equal(line.tagName, 'BUTTON');
    assert.equal(line.getAttribute('aria-expanded'), 'false');
    assert.equal(host.querySelector('.toolcall-image'), null, 'the image is inside the fold');
    act(() => line.click());
    assert.ok(host.querySelector('.toolcall-image'), 'opening shows the image');
  });

  it('is not rendered when the file no longer exists', async () => {
    freshPath(404, 'application/json');
    render(imageRead());
    await flush();
    assert.equal(host.querySelector('.toolline'), null);
  });

  it('is not rendered when the path now holds something other than an image', async () => {
    freshPath(200, 'text/plain');
    render(imageRead());
    await flush();
    assert.equal(host.querySelector('.toolline'), null);
  });

  it('a read with file text keeps its fold', () => {
    render(textRead());
    const line = host.querySelector('.toolline') as HTMLElement;
    assert.equal(line.tagName, 'BUTTON');
    assert.ok(host.querySelector('.toolline-chevron'), 'the affordance is there');
    assert.equal(line.getAttribute('aria-expanded'), 'false');
    act(() => line.click());
    assert.ok(host.querySelector('.toolcall-body'), 'and it opens onto real content');
    assert.equal(line.getAttribute('aria-expanded'), 'true');
  });
});

/* The DOM globals and React internals here are untyped by nature. */
type Any = any;

describe('a todo list call whose list kiro has emptied (rendered in a DOM)', () => {
  it('says all tasks are done instead of showing raw JSON', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://casper.test/' });
    const g = globalThis as Any;
    const w = dom.window as Any;
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) g[k] = w[k];
    g.IS_REACT_ACT_ENVIRONMENT = true;
    const react = await import('react');
    g.React = react.default ?? react;
    const { createRoot } = await import('react-dom/client');
    const { ToolCallCard } = await import('../web/src/components/chat/ToolCallCard.js');
    const host = w.document.getElementById('host');
    const tool = {
      id: 'todo-1',
      name: 'todo_list',
      title: 'todo_list',
      status: 'completed',
      input: { command: 'complete', completed_task_ids: ['3'] },
      content: [{ type: 'content', content: { type: 'text', text: '{"tasks":[],"description":"","context":[],"modified_files":[]}' } }],
    };
    const root = createRoot(host);
    react.act(() => root.render(react.createElement(ToolCallCard, { tool })));
    react.act(() => (host.querySelector('.toolline') as HTMLElement).click());
    assert.equal(host.querySelector('.todo-empty')?.textContent, 'All tasks done.');
    assert.equal(host.querySelector('.toolcall-section'), null, 'no input/output dump');
    react.act(() => root.unmount());
  });
});

describe('shell and web search bodies (rendered in a DOM)', () => {
  let react: Any;
  let host: Any;
  let root: Any;
  const open = async (tool: object) => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://casper.test/' });
    const g = globalThis as Any;
    const w = dom.window as Any;
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) g[k] = w[k];
    g.IS_REACT_ACT_ENVIRONMENT = true;
    react = await import('react');
    g.React = react.default ?? react;
    const { createRoot } = await import('react-dom/client');
    const { ToolCallCard } = await import('../web/src/components/chat/ToolCallCard.js');
    host = w.document.getElementById('host');
    root = createRoot(host);
    react.act(() => root.render(react.createElement(ToolCallCard, { tool })));
  };
  const click = () => react.act(() => (host.querySelector('.toolline') as HTMLElement).click());

  it('a shell call opens to the command under "bash" and its output under "Output"', async () => {
    await open({
      id: 'sh', name: 'shell', title: 'shell', status: 'completed',
      input: { command: 'date' },
      content: [{ type: 'content', content: { type: 'text', text: '{"exit_status":"exit status: 0","stdout":"Thu Oct 1\\n","stderr":""}' } }],
    });
    click();
    const labels = [...host.querySelectorAll('.shell-panel .shell-label')].map((l: Any) => l.textContent);
    assert.deepEqual(labels, ['bash', 'Output']);
    react.act(() => root.unmount());
  });

  it('a web search line shows its query, and opens to one row per result with its site', async () => {
    await open({
      id: 'ws', name: 'web_search', title: 'web_search', status: 'completed',
      input: { query: 'MuseScore MCP server' },
      // The shape kiro records: one json block holding the results.
      content: [{ kind: 'json', data: { results: [
        { title: 'MuseScore MCP Server', url: 'https://www.mcp.so/server/musescore' },
        { title: 'iflow mcp musescore', url: 'https://pypi.org/project/x/' },
      ] } }],
    });
    assert.equal(host.querySelector('.toolline-text').textContent, 'Searched the web');
    assert.equal(host.querySelector('.toolline-detail').textContent, 'MuseScore MCP server');
    click();
    const sites = [...host.querySelectorAll('.websearch-site')].map((s: Any) => s.textContent);
    assert.deepEqual(sites, ['mcp.so', 'pypi.org']);
    react.act(() => root.unmount());
  });
});
