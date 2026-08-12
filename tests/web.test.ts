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
