// Pure client logic: the store fold, tool rendering, diffing and call parsers.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type {
  CasperEvent,
  CasperEventPayload,
  DirListing,
  SessionDetail,
  SessionSummary,
} from '@casper/shared';
import { emptyObservabilitySnapshot } from '@casper/shared';
import { useStore } from '../web/src/state/store.js';
import { hydrateTranscript } from '../server/src/session/kiroFiles.js';
import { lineDiff } from '../web/src/util/diff.js';
import { matchPath } from 'react-router';
import { SESSION_ROUTE, pathForSession } from '../web/src/util/route.js';
import { choiceCallOf } from '../web/src/util/choiceCall.js';
import { widgetCallOf } from '../web/src/util/widgetCall.js';
import { lazyImageProps } from '../web/src/util/lazyImage.js';
import { classifyTurnFailure } from '../web/src/util/turnFailure.js';
import {
  classifyTool,
  toolLabel,
  langFromPath,
  outputText,
  firstJsonData,
  firstDiff,
  parseTodo,
  outputToBlocks,
  toolBlocks,
  soleStringField,
} from '../web/src/util/toolRender.js';
import {
  ATTACHMENTS_PREFIX,
  attachmentPaths,
  imageAttachmentPaths,
  stripAttachmentsLine,
} from '@casper/shared';
import { isUserScrollUp } from '../web/src/util/followScroll.js';
import {
  CONNECT_TIMEOUT_MS,
  PING_AFTER_MS,
  PONG_GRACE_MS,
  READY,
  shouldPing,
  shouldReconnect,
} from '../web/src/api/socketHealth.js';
import { SessionSocket } from '../web/src/api/SessionSocket.js';
import { sanitize } from 'hast-util-sanitize';
import { MARKDOWN_HTML_SCHEMA } from '../web/src/util/markdownHtml.js';
import {
  escapeCurrencyDollars,
  looksLikeMath,
} from '../web/src/util/currencyDollars.js';

describe('attachments line (drives image thumbnails; stripped from the bubble)', () => {
  const msg = `${ATTACHMENTS_PREFIX}.casper/uploads/a.png, .casper/uploads/notes.txt\nplease review`;

  it('attachmentPaths: parses both paths', () => {
    const paths = attachmentPaths(msg);
    assert.equal(paths.length, 2);
    assert.equal(paths[0], '.casper/uploads/a.png');
  });
  it('imageAttachmentPaths: keeps only images', () => {
    assert.equal(imageAttachmentPaths(msg).join(), '.casper/uploads/a.png');
  });
  it('stripAttachmentsLine: removes the attachments line', () => {
    assert.equal(stripAttachmentsLine(msg), 'please review');
  });
  it('attachmentPaths: none when absent', () => {
    assert.equal(attachmentPaths('just a message').length, 0);
  });
  it('stripAttachmentsLine: unchanged without the line', () => {
    assert.equal(stripAttachmentsLine('hello world'), 'hello world');
  });

  // Regression: a pasted-image-plus-text message. The composer terminates the
  // attachments line with '\n', so the turn_started echo and hydrateTranscript
  // (which join prompt text blocks with '', not '\n') still recover the typed
  // text and the image path - otherwise the line-based strip swallowed it.
  const joinedEmpty = [`${ATTACHMENTS_PREFIX}.casper/uploads/pasted.png\n`, 'look at this'].join('');
  it('attachments+text: typed text survives an empty-string join', () => {
    assert.equal(stripAttachmentsLine(joinedEmpty), 'look at this');
  });
  it('attachments+text: image path parsed after an empty-string join', () => {
    assert.equal(imageAttachmentPaths(joinedEmpty).join(), '.casper/uploads/pasted.png');
  });
});

describe('tool-call rendering: classifyTool', () => {
  const cls = classifyTool;
  // Canonical name drives classification identically live and hydrated.
  it('name shell', () => assert.equal(cls({ name: 'shell', title: 'Running: ...', input: {} }), 'shell'));
  it('name write', () => assert.equal(cls({ name: 'write', title: 'Editing x', input: {} }), 'write'));
  it('name read', () => assert.equal(cls({ name: 'read', title: 'Reading x', input: {} }), 'read'));
  it('name grep', () => assert.equal(cls({ name: 'grep', title: 'Searching for x', input: {} }), 'grep'));
  it('name todo_list', () => assert.equal(cls({ name: 'todo_list', title: 'Completing #1', input: {} }), 'todo'));
  it('name web_search -> websearch', () => assert.equal(cls({ name: 'web_search', title: 'Searching the web', input: {} }), 'websearch'));
  it('name web_fetch -> webfetch', () => assert.equal(cls({ name: 'web_fetch', title: 'Fetching a page', input: {} }), 'webfetch'));
  it('name introspect -> introspect', () => assert.equal(cls({ name: 'introspect', title: 'Looking it up', input: {} }), 'introspect'));

  // Fallback (no name): heuristics on kind + input shape.
  it('persisted shell', () => assert.equal(cls({ title: 'shell', input: { command: 'ls -la' } }), 'shell'));
  it('persisted write create', () => assert.equal(cls({ title: 'write', input: { command: 'create', path: '/a.ts', content: 'x' } }), 'write'));
  it('persisted read', () => assert.equal(cls({ title: 'read', input: { operations: [{ mode: 'Line', path: '/a' }] } }), 'read'));
  it('persisted grep', () => assert.equal(cls({ title: 'grep', input: { pattern: 'foo' } }), 'grep'));
  it('persisted todo', () => assert.equal(cls({ title: 'todo_list', input: { command: 'create', tasks: [] } }), 'todo'));
  it('live edit -> write', () => assert.equal(cls({ title: 'Editing app.css', kind: 'edit', input: { command: 'strReplace', path: '/x', oldStr: 'a', newStr: 'b' } }), 'write'));
  it('live search (pattern) -> grep', () => assert.equal(cls({ title: "Searching for 'x'", kind: 'search', input: { pattern: 'x', path: '/y' } }), 'grep'));
  it('web_search (query) -> websearch', () => assert.equal(cls({ title: 'web_search', kind: 'search', input: { query: 'x' } }), 'websearch'));
  it('live web_search -> websearch', () => assert.equal(cls({ title: 'Searching the web', kind: 'search', input: { query: 'x' } }), 'websearch'));
  it('web_fetch (url) -> webfetch', () => assert.equal(cls({ title: 'web_fetch', input: { url: 'https://x' } }), 'webfetch'));
  it('introspect (title) -> introspect', () => assert.equal(cls({ title: 'introspect', input: { query: 'x' } }), 'introspect'));
  it('introspect (doc_path) -> introspect', () => assert.equal(cls({ title: 'Looking it up', input: { doc_path: 'features/x.md' } }), 'introspect'));
  it('live execute -> shell', () => assert.equal(cls({ title: 'Running a command', kind: 'execute', input: { command: 'git status' } }), 'shell'));
  it('live read', () => assert.equal(cls({ title: 'Reading dir', kind: 'read', input: { operations: [{ mode: 'Directory', path: '/z' }] } }), 'read'));
  it('live todo complete', () => assert.equal(cls({ title: 'Completing #1', input: { command: 'complete', completed_task_ids: ['1'] } }), 'todo'));
  it('live create -> write (not todo)', () => assert.equal(cls({ title: 'Creating x.ts', kind: 'edit', input: { command: 'create', path: '/x.ts', content: 'y' } }), 'write'));
  it('unknown -> generic', () => assert.equal(cls({ title: 'mystery', input: {} }), 'generic'));
});

describe('tool-call rendering: toolLabel (header identical live vs hydrated)', () => {
  it('name web_search live', () => assert.equal(toolLabel({ name: 'web_search', title: 'Searching the web' }), 'web_search'));
  it('name web_search hydrated', () => assert.equal(toolLabel({ name: 'web_search', title: 'web_search' }), 'web_search'));
  it('name shell', () => assert.equal(toolLabel({ name: 'shell', title: 'Running: echo hi' }), 'shell'));
  it('write consistent live vs hydrated', () => {
    assert.equal(toolLabel({ title: 'Editing app.css', kind: 'edit', input: { command: 'strReplace', path: '/x', oldStr: 'a', newStr: 'b' } }), 'write');
    assert.equal(toolLabel({ title: 'write', input: { command: 'strReplace', path: '/x', oldStr: 'a', newStr: 'b' } }), 'write');
  });
  it('shell consistent live vs hydrated', () => {
    assert.equal(toolLabel({ title: 'Running: echo hi', kind: 'execute', input: { command: 'echo hi' } }), 'shell');
    assert.equal(toolLabel({ title: 'shell', input: { command: 'echo hi' } }), 'shell');
  });
  it('todo_list consistent live vs hydrated', () => {
    assert.equal(toolLabel({ title: 'Creating task list: ...', input: { command: 'create', tasks: [] } }), 'todo_list');
    assert.equal(toolLabel({ title: 'todo_list', input: { command: 'complete', completed_task_ids: ['1'] } }), 'todo_list');
  });
  it('generic keeps a single-token name', () => assert.equal(toolLabel({ title: 'web_fetch', input: {} }), 'web_fetch'));
  it('generic human title -> tool', () => assert.equal(toolLabel({ title: 'Fetching a page', input: {} }), 'tool'));

  // Live, kiro sends the tool name bare and only the title carries the server.
  it('mcp tool live -> @server/tool', () =>
    assert.equal(
      toolLabel({ name: 'show_widget', title: 'Running: @casper/show_widget' }),
      '@casper/show_widget',
    ));

  it('mcp tool from a namespaced name', () =>
    assert.equal(toolLabel({ name: 'casper/read_me' }), '@casper/read_me'));

  it('mcp tool whose name already carries the @', () =>
    assert.equal(toolLabel({ name: '@casper/show_choice' }), '@casper/show_choice'));

  // A shell command can contain something that looks like a namespace.
  it('a package scope in a shell title is not an mcp tool', () =>
    assert.equal(
      toolLabel({ name: 'shell', title: 'Running: npm i @casper/web' }),
      'shell',
    ));

  it('another server namespaces the same way', () =>
    assert.equal(
      toolLabel({ name: 'search_docs', title: 'Running: @context7/search_docs' }),
      '@context7/search_docs',
    ));
});

describe('tool-call rendering: langFromPath', () => {
  it('.tsx -> tsx', () => assert.equal(langFromPath('web/src/App.tsx'), 'tsx'));
  it('.css -> css', () => assert.equal(langFromPath('a/b/styles.css'), 'css'));
  it('.py -> python', () => assert.equal(langFromPath('/tmp/x.py'), 'python'));
  it('Dockerfile -> docker', () => assert.equal(langFromPath('Dockerfile'), 'docker'));
  it('unknown -> text', () => assert.equal(langFromPath('/tmp/Caddyfile'), 'text'));
  it('no extension -> text', () => assert.equal(langFromPath('noext'), 'text'));
});

describe('tool-call rendering: output extractors', () => {
  it('outputText: ACP content block', () => {
    assert.equal(outputText([{ type: 'content', content: { type: 'text', text: 'live-out' } }]), 'live-out');
  });
  it('outputText: persisted text', () => assert.equal(outputText([{ kind: 'text', data: 'persisted' }]), 'persisted'));
  it('outputText: acp text block', () => assert.equal(outputText([{ type: 'text', text: 'acp' }]), 'acp'));
  it('outputText: json block ignored', () => assert.equal(outputText([{ kind: 'json', data: { stdout: 'x' } }]), ''));

  it('firstJsonData: returns the data object', () => {
    const j = firstJsonData([{ kind: 'json', data: { exit_status: 'exit status: 0', stdout: 'hi' } }]);
    assert.ok(j);
    assert.equal(j.stdout, 'hi');
  });
  it('firstJsonData: none when absent', () => assert.equal(firstJsonData([{ kind: 'text', data: 'x' }]), null));
  it('firstDiff: live diff block', () => {
    const d = firstDiff([{ type: 'diff', path: '/a.ts', oldText: 'old', newText: 'new' }]);
    assert.ok(d);
    assert.equal(d.oldText, 'old');
    assert.equal(d.newText, 'new');
    assert.equal(d.path, '/a.ts');
  });
  it('firstDiff: none when absent', () => assert.equal(firstDiff([{ kind: 'text', data: 'x' }]), null));
});

describe('tool-call rendering: parseTodo', () => {
  it('persisted json tasks', () => {
    const persisted = parseTodo([
      { kind: 'json', data: { tasks: [{ task_description: 'a', completed: true }, { task_description: 'b', completed: false }] } },
    ]);
    assert.ok(persisted);
    assert.equal(persisted.length, 2);
    assert.ok(persisted[0]!.done);
    assert.ok(!persisted[1]!.done);
    assert.equal(persisted[0]!.desc, 'a');
  });
  it('live JSON text tasks', () => {
    const live = parseTodo([
      { type: 'content', content: { type: 'text', text: '{"tasks":[{"task_description":"c","completed":true}]}' } },
    ]);
    assert.ok(live);
    assert.equal(live.length, 1);
    assert.ok(live[0]!.done);
    assert.equal(live[0]!.desc, 'c');
  });
  it('none when no task list', () => assert.equal(parseTodo([{ kind: 'text', data: 'not json' }]), null));
});

describe('tool-call rendering: outputToBlocks / toolBlocks (live rawOutput)', () => {
  it('Text item -> text', () => {
    assert.equal(outputText(outputToBlocks({ items: [{ Text: 'file contents' }] })), 'file contents');
  });
  it('Json item -> json data', () => {
    const shellJson = firstJsonData(outputToBlocks({ items: [{ Json: { stdout: 'ok', stderr: '', exit_status: 'exit status: 0' } }] }));
    assert.ok(shellJson);
    assert.equal(shellJson.stdout, 'ok');
  });
  it('plain string -> text', () => assert.equal(outputText(outputToBlocks('raw string')), 'raw string'));
  it('null -> empty', () => assert.equal(outputToBlocks(null).length, 0));
  it('live read output text', () => {
    assert.equal(outputText(toolBlocks({ content: [], output: { items: [{ Text: 'pkg json' }] } })), 'pkg json');
  });
  it('live todo tasks from output', () => {
    const liveTodo = parseTodo(
      toolBlocks({ content: [], output: { items: [{ Json: { tasks: [{ task_description: 'x', completed: true }] } }] } }),
    );
    assert.ok(liveTodo);
    assert.equal(liveTodo.length, 1);
    assert.ok(liveTodo[0]!.done);
  });
});

describe('tool-call rendering: soleStringField', () => {
  it('single string field', () => assert.equal(soleStringField({ documentation: 'the docs' }), 'the docs'));
  it('multiple fields -> null', () => assert.equal(soleStringField({ a: 'x', b: 'y' }), null));
  it('non-string field -> null', () => assert.equal(soleStringField({ n: 5 }), null));
  it('introspect output unwrapped', () => {
    const introspect = firstJsonData(toolBlocks({ content: [], output: { items: [{ Json: { documentation: 'ACP docs...' } }] } }));
    assert.ok(introspect);
    assert.equal(soleStringField(introspect), 'ACP docs...');
  });
});

describe('line diff (LCS): context kept, only changed lines marked', () => {
  const d = lineDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');
  it('leading context kept', () => {
    assert.equal(d[0]!.type, 'ctx');
    assert.equal(d[0]!.text, 'alpha');
  });
  it('trailing context kept', () => assert.equal(d[d.length - 1]!.type, 'ctx'));
  it('removed line marked del', () => assert.ok(d.some((l) => l.type === 'del' && l.text === 'beta')));
  it('added line marked add', () => assert.ok(d.some((l) => l.type === 'add' && l.text === 'BETA')));
  it('identical text all context', () => assert.ok(lineDiff('x\ny', 'x\ny').every((l) => l.type === 'ctx')));
});

describe('store.applyEvent (duplicate event suppression)', () => {
  const userTurn = (seq: number, text: string): CasperEvent => ({
    seq,
    sessionId: 's1',
    ts: new Date('2026-07-29T12:00:00Z').toISOString(),
    payload: {
      kind: 'turn_started',
      prompt: [{ type: 'text', text }],
    } as CasperEventPayload,
  });

  const toolCall = (seq: number, id: string): CasperEvent => ({
    seq,
    sessionId: 's1',
    ts: new Date('2026-07-29T12:00:01Z').toISOString(),
    payload: {
      kind: 'session_update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'Remove the untracked screenshot',
        kind: 'execute',
        status: 'pending',
      },
    } as unknown as CasperEventPayload,
  });

  beforeEach(() => {
    useStore.getState().clearActive();
  });

  it('applies a new event once', () => {
    useStore.getState().applyEvent(userTurn(1, 'hello'));
    const items = useStore.getState().items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, 'message');
  });

  it('ignores an event redelivered at the same seq', () => {
    const e = userTurn(1, 'squash and push current changes');
    useStore.getState().applyEvent(e);
    useStore.getState().applyEvent(e);
    assert.equal(useStore.getState().items.length, 1);
  });

  it('ignores a replayed burst below the high-water mark', () => {
    useStore.getState().applyEvent(userTurn(1, 'first'));
    useStore.getState().applyEvent(toolCall(2, 'tc-1'));
    assert.equal(useStore.getState().items.length, 2);

    // A second socket replaying the same range, as a woken phone used to do.
    useStore.getState().applyEvent(userTurn(1, 'first'));
    useStore.getState().applyEvent(toolCall(2, 'tc-1'));
    assert.equal(useStore.getState().items.length, 2);
  });

  it('still applies events above the high-water mark after a replay', () => {
    useStore.getState().applyEvent(userTurn(1, 'first'));
    useStore.getState().applyEvent(userTurn(1, 'first'));
    useStore.getState().applyEvent(toolCall(2, 'tc-1'));
    assert.equal(useStore.getState().items.length, 2);
  });

  it('loadDetail seeds the high-water mark so replayed events are dropped', () => {
    useStore.getState().loadDetail({
      summary: { sessionId: 's1', title: 't', updatedAt: '', modelId: 'auto' },
      transcript: [],
      transcriptTotal: 0,
      head: 5,
      modes: [],
      observability: emptyObservabilitySnapshot(),
    } as unknown as SessionDetail);

    // Everything up to head is already in the fetched transcript.
    useStore.getState().applyEvent(userTurn(3, 'already in the transcript'));
    assert.equal(useStore.getState().items.length, 0);

    useStore.getState().applyEvent(userTurn(6, 'genuinely new'));
    assert.equal(useStore.getState().items.length, 1);
  });
});

describe('lazyImageProps (placeholder box release)', () => {
  it('defers loading and decoding', () => {
    assert.equal(lazyImageProps.loading, 'lazy');
    assert.equal(lazyImageProps.decoding, 'async');
  });

  it('marks an image loaded so CSS drops the reserved box', () => {
    const el = { dataset: {} as Record<string, string> };
    lazyImageProps.onLoad({ currentTarget: el as unknown as HTMLImageElement });
    assert.equal(el.dataset.loaded, '');
  });

  it('marks an already-complete (cached) image on mount', () => {
    const cached = { complete: true, dataset: {} as Record<string, string> };
    lazyImageProps.ref(cached as unknown as HTMLImageElement);
    assert.equal(cached.dataset.loaded, '');
  });

  it('leaves an incomplete image for onLoad to mark', () => {
    const pending = { complete: false, dataset: {} as Record<string, string> };
    lazyImageProps.ref(pending as unknown as HTMLImageElement);
    assert.equal(pending.dataset.loaded, undefined);
  });
});

describe('classifyTurnFailure', () => {
  it('recognises expired credentials as session-wide, with the login remedy', () => {
    const f = classifyTurnFailure(
      "kiro-cli exited with code 1: Error: your credentials have expired. Run 'kiro-cli login'.",
    );
    assert.equal(f.title, "Kiro isn't authenticated");
    assert.equal(f.sessionWide, true);
    assert.match(f.fix ?? '', /kiro-cli login/);
  });

  it('recognises a missing binary as session-wide', () => {
    const f = classifyTurnFailure('spawn kiro-cli ENOENT');
    assert.equal(f.sessionWide, true);
    assert.match(f.fix ?? '', /KIRO_BIN/);
  });

  it('treats a busy session as a one-off, not session-wide', () => {
    const f = classifyTurnFailure('A turn is already running for this session');
    assert.notEqual(f.sessionWide, true);
  });

  it('invents no advice for an unrecognised failure', () => {
    const f = classifyTurnFailure('something entirely unexpected happened');
    assert.equal(f.title, 'Turn failed');
    assert.equal(f.fix, undefined);
    assert.notEqual(f.sessionWide, true);
  });
});

describe('session deep links', () => {
  // The builder and the route pattern have to agree, or a link navigates to a
  // URL the app doesn't match and quietly lands on the session list.
  it('builds paths the route pattern matches', () => {
    const id = 'c959cc04-2a80-494b-bef8-9e7315ff4abd';
    assert.equal(matchPath(SESSION_ROUTE, pathForSession(id))?.params.sessionId, id);
  });

  it('does not match the list route', () => {
    assert.equal(matchPath(SESSION_ROUTE, '/'), null);
  });
});

describe('widget tool call parsing', () => {
  const base = { id: 't1', title: 'show_widget', status: 'completed' as const, content: [] };

  it('matches the namespaced name kiro reports', () => {
    const call = widgetCallOf({
      ...base, name: 'casper___show_widget',
      input: { title: 'a_b', widget_code: '<p>x</p>' },
    });
    assert.equal(call?.title, 'a_b');
    assert.equal(call?.code, '<p>x</p>');
  });

  // The exact rawInput kiro delivered in a live session, __My_purpose and all.
  it('reads the payload kiro actually sends', () => {
    const call = widgetCallOf({
      ...base,
      name: 'show_widget',
      title: 'Running: @casper/show_widget',
      input: {
        __My_purpose: 'show a slider',
        i_have_seen_read_me: true,
        title: 'square_slider',
        widget_code: '<style>p{color:red}</style><p>x</p>',
      },
    });
    assert.equal(call?.title, 'square_slider');
    assert.match(call!.code, /<style>/);
  });

  it('ignores other tools', () => {
    assert.equal(widgetCallOf({ ...base, name: 'fs_read', input: {} }), null);
    assert.equal(widgetCallOf({ ...base, name: undefined, input: {} }), null);
  });
});

describe('choice call parsing', () => {
  const base = { id: 't9', title: 'Running: @casper/show_choice', status: 'completed' as const, content: [] };
  const call = (input: unknown) => choiceCallOf({ ...base, name: 'show_choice', input });

  it('defaults an option prompt to its label, since that is what was tapped', () => {
    const data = call({
      question: 'Push?', options: [{ label: 'Push now' }, { label: 'Wait', prompt: 'hold off' }],
    });
    assert.deepEqual(data?.options.map((o) => o.prompt), ['Push now', 'hold off']);
  });

  it('ignores other tools, and a choice with nothing to choose', () => {
    assert.equal(choiceCallOf({ ...base, name: 'fs_read', input: {} }), null);
    assert.equal(call({ question: 'Which?', options: [{ label: 'only one' }] }), null);
  });
});

describe('follow-bottom: a gesture versus a reflow', () => {
  // The range is unchanged, so the whole drop is the user's.
  it('a real scroll up stops following', () => {
    assert.equal(
      isUserScrollUp(500, 900, 1000, 1000),
      true,
    );
  });

  // The bug: a thought block collapsing shrank the content, the browser clamped
  // scrollTop, and reading that as a scroll up stopped following for the whole turn.
  it('clamping after the content shrinks does not', () => {
    assert.equal(
      isUserScrollUp(600, 900, 600, 900),
      false,
    );
  });

  // The range lost 300 but scrollTop fell 500, so 200 of it was the user.
  it('a scroll up during a shrink still counts', () => {
    assert.equal(
      isUserScrollUp(400, 900, 600, 900),
      true,
    );
  });

  it('ignores sub-pixel jitter', () => {
    assert.equal(
      isUserScrollUp(897, 900, 1000, 1000),
      false,
    );
  });

  it('scrolling down never stops following', () => {
    assert.equal(
      isUserScrollUp(950, 900, 1000, 1000),
      false,
    );
  });
});

describe('socket health', () => {
  const now = 1_000_000;
  const sample = (over: Partial<Parameters<typeof shouldReconnect>[0]>) => ({
    state: READY.OPEN as number | undefined,
    connectingSince: now,
    lastMessageAt: now,
    now,
    ...over,
  });

  it('reconnects when there is no socket', () => {
    assert.equal(shouldReconnect(sample({ state: undefined })), true);
  });

  it('reconnects on a closed or closing socket', () => {
    assert.equal(shouldReconnect(sample({ state: READY.CLOSED })), true);
    assert.equal(shouldReconnect(sample({ state: READY.CLOSING })), true);
  });

  // The guard exists to stop a waking phone opening two sockets, so it has to hold
  // for an attempt that is genuinely young.
  it('leaves a young connect attempt alone', () => {
    assert.equal(
      shouldReconnect(sample({ state: READY.CONNECTING, connectingSince: now - 1_000 })),
      false,
    );
  });

  // The bug: frozen across a suspend, it never opens or closes, so nothing retried.
  it('abandons a connect that never resolved', () => {
    assert.equal(
      shouldReconnect(
        sample({ state: READY.CONNECTING, connectingSince: now - CONNECT_TIMEOUT_MS - 1 }),
      ),
      true,
    );
  });

  it('keeps an open socket that is still hearing traffic', () => {
    assert.equal(shouldReconnect(sample({ lastMessageAt: now - 1_000 })), false);
  });

  it('replaces an open socket that has gone silent past the grace period', () => {
    const silent = now - (PING_AFTER_MS + PONG_GRACE_MS) - 1;
    assert.equal(shouldReconnect(sample({ lastMessageAt: silent })), true);
  });

  it('pings a quiet open socket before giving up on it', () => {
    const quiet = sample({ lastMessageAt: now - PING_AFTER_MS - 1 });
    assert.equal(shouldPing(quiet), true);
    assert.equal(shouldReconnect(quiet), false);
  });

  it('does not ping a socket that is not open', () => {
    assert.equal(shouldPing(sample({ state: READY.CONNECTING })), false);
  });
});

describe('socket watchdog: a connect that never resolves', () => {
  /** A socket that connects forever: no open, no close. */
  class FrozenWs {
    // SessionSocket compares against these when closing a socket it replaces.
    static readonly CONNECTING = READY.CONNECTING;
    static readonly OPEN = READY.OPEN;
    static readonly CLOSING = READY.CLOSING;
    static readonly CLOSED = READY.CLOSED;
    static instances: FrozenWs[] = [];
    readyState = READY.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      FrozenWs.instances.push(this);
    }
    close() {
      this.readyState = READY.CLOSED;
    }
    send() {}
  }

  /** Drive SessionSocket with our own window, clock and socket. */
  function harness(run: (tick: () => void, advance: (ms: number) => void) => void) {
    const g = globalThis as Record<string, unknown>;
    const saved = {
      window: g.window,
      document: g.document,
      location: g.location,
      WebSocket: g.WebSocket,
      now: Date.now,
    };
    const intervals: (() => void)[] = [];
    let clock = 1_000_000;
    g.window = {
      addEventListener() {},
      removeEventListener() {},
      setInterval: (fn: () => void) => intervals.push(fn),
      clearInterval() {},
      setTimeout: () => 0,
      clearTimeout() {},
    };
    g.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
    g.location = { protocol: 'http:', host: 'localhost:4319' };
    g.WebSocket = FrozenWs;
    Date.now = () => clock;
    FrozenWs.instances = [];
    try {
      run(
        () => intervals.forEach((fn) => fn()),
        (ms) => {
          clock += ms;
        },
      );
    } finally {
      Object.assign(g, saved);
      Date.now = saved.now;
    }
  }

  const noop = {
    onEvent() {},
    onStatus() {},
    onResync() {},
  };

  it('opens a second socket once the first is past the timeout', () => {
    harness((tick, advance) => {
      const sock = new SessionSocket('s1', noop, 5);
      sock.connect();
      assert.equal(FrozenWs.instances.length, 1, 'one attempt to begin with');

      advance(1_000);
      tick();
      assert.equal(FrozenWs.instances.length, 1, 'a young attempt is left alone');

      advance(CONNECT_TIMEOUT_MS);
      tick();
      assert.equal(FrozenWs.instances.length, 2, 'the frozen attempt is replaced');
      assert.equal(FrozenWs.instances[0]!.readyState, READY.CLOSED, 'and the old one closed');
    });
  });

  it('reports reconnecting rather than going quiet', () => {
    harness((tick, advance) => {
      const seen: string[] = [];
      const sock = new SessionSocket('s1', { ...noop, onStatus: (st) => seen.push(st) }, 5);
      sock.connect();
      advance(CONNECT_TIMEOUT_MS + 1);
      tick();
      assert.deepEqual(seen, ['reconnecting', 'reconnecting']);
    });
  });
});

describe('markdown HTML sanitising', () => {
  interface El {
    type: 'element';
    tagName: string;
    properties: Record<string, unknown>;
    children: El[];
  }
  const el = (tagName: string, properties: Record<string, unknown> = {}, children: El[] = []) =>
    ({ type: 'element', tagName, properties, children }) as El;
  const clean = (tree: El) =>
    sanitize({ type: 'root', children: [tree] } as never, MARKDOWN_HTML_SCHEMA) as {
      children: El[];
    };
  const first = (tree: El) => clean(tree).children[0];

  // The README banner: a centred paragraph holding a sized image.
  it('keeps the attributes a README banner needs', () => {
    const out = first(
      el('p', { align: 'center' }, [
        el('img', { src: 'https://example.com/banner.svg', alt: 'banner', width: '100%' }),
      ]),
    );
    assert.equal(out.tagName, 'p');
    assert.equal(out.properties.align, 'center');
    const img = out.children[0]!;
    assert.equal(img.properties.src, 'https://example.com/banner.svg');
    assert.equal(img.properties.width, '100%');
    assert.equal(img.properties.alt, 'banner');
  });

  // The file browser opens anything under fileRoot, so this is untrusted input
  // rendered in Casper's origin, where script could call the API as the user.
  it('drops script entirely', () => {
    const out = clean(el('script', {}, []));
    assert.equal(out.children.length, 0);
  });

  it('drops event handlers but keeps the element', () => {
    const out = first(el('img', { src: 'x.png', onError: 'alert(1)', onClick: 'alert(2)' }));
    assert.equal(out.tagName, 'img');
    assert.equal(out.properties.src, 'x.png');
    assert.equal(out.properties.onError, undefined);
    assert.equal(out.properties.onClick, undefined);
  });

  it('drops a javascript: link but keeps the text', () => {
    const out = first(el('a', { href: 'javascript:alert(1)' }, []));
    assert.equal(out.tagName, 'a');
    assert.equal(out.properties.href, undefined);
  });

  it('keeps an ordinary link', () => {
    const out = first(el('a', { href: 'https://example.com' }, []));
    assert.equal(out.properties.href, 'https://example.com');
  });

  it('drops an iframe, which would be a frame inside the app origin', () => {
    assert.equal(clean(el('iframe', { src: 'https://example.com' })).children.length, 0);
  });
});

describe('currency versus inline math', () => {
  const math = ['x', 'x^2', 'n_i', '\\alpha + \\beta', '\\frac{a}{b}', 'E = mc^2', '2n', 'a+b', '\\pi'];
  const money = [
    '50',
    '3.5B',
    '1,000,000',
    '3.5B valuation in 2022, and its budgets have climbed - *Civil War* was around ',
    'HOME and ',
    '5 and ',
    '50M last year and ',
  ];

  for (const m of math) {
    it(`reads ${m} as math`, () => assert.equal(looksLikeMath(m), true));
  }
  for (const m of money) {
    it(`reads ${JSON.stringify(m.slice(0, 28))} as not math`, () =>
      assert.equal(looksLikeMath(m), false));
  }

  // The reported turn: two amounts in one sentence made everything between them a
  // formula, emphasis included.
  it('escapes an amount pair and leaves the markdown between it alone', () => {
    const out = escapeCurrencyDollars(
      'A24 raised ~$3.5B in 2022 and *Civil War* cost about $50M.',
    );
    // Only the opener needs escaping; the trailing dollar is unpaired and literal.
    assert.equal(out, 'A24 raised ~\\$3.5B in 2022 and *Civil War* cost about $50M.');
  });

  // The dollar closing a currency pair can be the one opening real math.
  it('keeps math that follows an amount in the same line', () => {
    assert.equal(
      escapeCurrencyDollars('Paying $30 for a shirt while $x^2 + y^2 = z^2$ stays true.'),
      'Paying \\$30 for a shirt while $x^2 + y^2 = z^2$ stays true.',
    );
  });

  it('leaves real inline math untouched', () => {
    const src = 'The area is $\\pi r^2$ exactly.';
    assert.equal(escapeCurrencyDollars(src), src);
  });

  it('leaves display math untouched', () => {
    const src = 'Before\n\n$$\n\\int_0^1 x^2 dx\n$$\n\nAfter';
    assert.equal(escapeCurrencyDollars(src), src);
  });

  // Escaping inside code would show the backslash to the reader.
  it('does not touch a code span', () => {
    const src = 'Run `echo $HOME` and `df -h $PWD` first.';
    assert.equal(escapeCurrencyDollars(src), src);
  });

  it('does not touch a fenced block', () => {
    const src = '```sh\nexport COST=$50\necho $HOME\n```\n';
    assert.equal(escapeCurrencyDollars(src), src);
  });

  it('leaves an unpaired dollar alone, which markdown already renders literally', () => {
    assert.equal(escapeCurrencyDollars('It cost $50 all in.'), 'It cost $50 all in.');
  });
});
