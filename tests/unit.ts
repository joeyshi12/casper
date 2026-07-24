// Unit tests for the pure fold logic (no processes or network).
// Run with: npm test   (Node's built-in test runner via tsx)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { CasperEventPayload, SessionSummary } from '@casper/shared';
import { config } from '../server/src/config.js';
import { TurnState } from '../server/src/session/TurnState.js';
import { SessionManager, Session } from '../server/src/session/SessionManager.js';
import { EventStore } from '../server/src/session/EventStore.js';
import {
  confineToRoot,
  isValidSessionId,
  isWithinRoot,
  realConfineToRoot,
} from '../server/src/util/paths.js';
import { classifyKind, looksBinary } from '../server/src/util/filekind.js';
import { bumpSessionToTop } from '../web/src/state/sessions.js';
import { olderPageRequest } from '../web/src/state/pagination.js';
import { lineDiff } from '../web/src/util/diff.js';
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

// A no-op logger for components that require one.
function noopLogger() {
  const log = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
    child() {
      return log;
    },
  };
  return log as unknown as import('../server/src/util/logger.js').Logger;
}

describe('TurnState: observability fold across a full turn', () => {
  // A representative stream of events across one full turn, then a second turn.
  const events: CasperEventPayload[] = [
    { kind: 'commands_available', params: { sessionId: 's', commands: [{ name: '/agent' }] } },
    { kind: 'mcp_health', params: { sessionId: 's', serverName: 'builder-mcp' }, ok: true },
    { kind: 'mcp_health', params: { sessionId: 's', serverName: 'pippin-mcp', error: 'boom' }, ok: false },
    { kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] },
    { kind: 'session_update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } },
    { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 15.9, meteringUsage: [{ value: 0.04, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 1916 } },
    { kind: 'turn_ended', stopReason: 'end_turn' },
    { kind: 'turn_started', prompt: [{ type: 'text', text: 'again' }] },
    { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 22.1, meteringUsage: [{ value: 0.06, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 3000 } },
    { kind: 'turn_ended', stopReason: 'end_turn' },
  ];
  const ts = new TurnState();
  for (const e of events) ts.apply(e);
  const snap = ts.get();

  it('cumulative credits accumulate across turns', () => {
    assert.ok(Math.abs(snap.creditsSpent - 0.1) < 1e-9, `creditsSpent=${snap.creditsSpent}`);
  });
  it('lastTurnCredits reflects most recent turn', () => {
    assert.ok(Math.abs(snap.lastTurnCredits - 0.06) < 1e-9, `lastTurnCredits=${snap.lastTurnCredits}`);
  });
  it('contextUsagePercentage takes latest value', () => {
    assert.equal(snap.contextUsagePercentage, 22.1);
  });
  it('lastTurnDurationMs takes latest value', () => {
    assert.equal(snap.lastTurnDurationMs, 3000);
  });
  it('turnStatus returns to idle after turn_ended', () => {
    assert.equal(snap.turnStatus, 'idle');
  });
  it('both MCP servers tracked', () => {
    assert.equal(snap.mcpServers.length, 2);
  });
  it('failed MCP server marked failed', () => {
    assert.equal(snap.mcpServers.find((m) => m.serverName === 'pippin-mcp')?.status, 'failed');
  });
  it('healthy MCP server marked initialized', () => {
    assert.equal(snap.mcpServers.find((m) => m.serverName === 'builder-mcp')?.status, 'initialized');
  });
  it('available commands captured', () => {
    assert.equal(snap.availableCommands.length, 1);
  });
});

describe('TurnState: compaction status', () => {
  it('compacting defaults to false', () => {
    assert.equal(new TurnState().get().compacting, false);
  });
  it('compaction started sets compacting true', () => {
    const t = new TurnState();
    t.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'started' }, summary: null } });
    assert.equal(t.get().compacting, true);
  });
  it('compaction completed clears compacting', () => {
    const t = new TurnState();
    t.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'started' }, summary: null } });
    t.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'completed' }, summary: 'sum' } });
    assert.equal(t.get().compacting, false);
  });
});

describe('TurnState: resume, crash, and oauth', () => {
  it('seed sets cumulative credits on resume', () => {
    const t = new TurnState();
    t.seed(1.5, 40);
    assert.equal(t.get().creditsSpent, 1.5);
  });
  it('seed sets context usage on resume', () => {
    const t = new TurnState();
    t.seed(1.5, 40);
    assert.equal(t.get().contextUsagePercentage, 40);
  });
  it('turnStatus running after turn_started', () => {
    const t = new TurnState();
    t.apply({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] });
    assert.equal(t.get().turnStatus, 'running');
  });
  it('process_exited resets turnStatus to idle', () => {
    // A crash mid-turn must not leave a REST refetch reporting a stuck 'running'.
    const t = new TurnState();
    t.apply({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] });
    t.apply({ kind: 'process_exited', code: 1, signal: null });
    assert.equal(t.get().turnStatus, 'idle');
  });
  it('oauth_request accumulates an oauth prompt', () => {
    const t = new TurnState();
    t.apply({ kind: 'oauth_request', params: { sessionId: 's', serverName: 'gh', url: 'https://x' } });
    assert.equal(t.get().oauthPrompts.length, 1);
  });
});

describe('path confinement (bounds all file-serving endpoints)', () => {
  it('isWithinRoot: nested path allowed', () => assert.ok(isWithinRoot('/home/joey', '/home/joey/a/b')));
  it('isWithinRoot: root itself allowed', () => assert.ok(isWithinRoot('/home/joey', '/home/joey')));
  it('isWithinRoot: prefix-match blocked', () => assert.ok(!isWithinRoot('/home/joey', '/home/joeyx/x')));
  it('isWithinRoot: fs root contains everything', () => assert.ok(isWithinRoot('/', '/etc/passwd')));
  it('confineToRoot: relative resolved', () => assert.equal(confineToRoot('/home/joey', 'a/b'), '/home/joey/a/b'));
  it('confineToRoot: traversal blocked', () => assert.equal(confineToRoot('/home/joey', '../etc'), null));
  it('confineToRoot: out-of-root absolute blocked', () => assert.equal(confineToRoot('/home/joey', '/etc/passwd'), null));
  it('isValidSessionId: uuid accepted', () => assert.ok(isValidSessionId('ec0afd54-d34c-4da8-ac92-051841321930')));
  it('isValidSessionId: traversal rejected', () => assert.ok(!isValidSessionId('../../etc/passwd')));
  it('isValidSessionId: separator rejected', () => assert.ok(!isValidSessionId('a/b')));
  it('isValidSessionId: dot rejected', () => assert.ok(!isValidSessionId('.')));
});

describe('upload classification (how a file is surfaced to the agent)', () => {
  it('image by extension (case-insensitive)', () => assert.equal(classifyKind('photo.PNG'), 'image'));
  it('markdown is text', () => assert.equal(classifyKind('notes.md'), 'text'));
  it('source code is text', () => assert.equal(classifyKind('main.rs'), 'text'));
  it('exe is binary', () => assert.equal(classifyKind('sample.exe'), 'binary'));
  it('gzip is binary', () => assert.equal(classifyKind('archive.tar.gz'), 'binary'));
  it('no extension defaults to binary', () => assert.equal(classifyKind('noext'), 'binary'));
});

describe('binary content sniff (rescues extensionless/dotfile text)', () => {
  it('gitignore-style text is text', () => assert.ok(!looksBinary(Buffer.from('node_modules\ndist\n'))));
  it('nvmrc-style text is text', () => assert.ok(!looksBinary(Buffer.from('20.11.0\n'))));
  it('empty file is text', () => assert.ok(!looksBinary(Buffer.from(''))));
  it('utf-8 text is text', () => assert.ok(!looksBinary(Buffer.from('héllo café\tτ\n', 'utf8'))));
  it('NUL byte marks binary', () => assert.ok(looksBinary(Buffer.from([0x00, 0x01, 0x02, 0x00]))));
  it('PNG header marks binary', () => assert.ok(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))));
  it('UTF-16 LE BOM marks binary', () => assert.ok(looksBinary(Buffer.from([0xff, 0xfe, 0x41, 0x00]))));
  // Control-char ratio threshold is > 0.3: 3/10 stays text, 4/10 is binary.
  it('exactly 30% control chars is text', () => {
    assert.ok(!looksBinary(Buffer.from([0x01, 0x01, 0x01, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41])));
  });
  it('40% control chars is binary', () => {
    assert.ok(looksBinary(Buffer.from([0x01, 0x01, 0x01, 0x01, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41])));
  });
});

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

describe('EventStore.getSince + SessionManager.wire replay gating', () => {
  // kiro replays the whole conversation as notifications during session/load;
  // those must be dropped while Session.replaying is set (the transcript is
  // already hydrated from disk), and turn lifecycle events must reach turnState.
  let store: EventStore;
  let session: Session;
  let proc: EventEmitter;
  const toolCall = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x' } },
  };

  before(() => {
    const log = noopLogger();
    const mgr = new SessionManager(log) as unknown as { wire(s: unknown, proc: unknown): void };
    store = new EventStore('replay-regression-test', log);
    session = new Session('replay-regression-test', store, '/tmp');
    proc = new EventEmitter();
    mgr.wire(session, proc);
  });
  after(() => {
    store.dispose();
    try {
      fs.rmSync(path.join(config.casperDataDir, 'replay-regression-test.events.jsonl'), { force: true });
    } catch {
      /* best effort */
    }
  });

  // Empty-buffer cursor semantics (run first, before any events are appended).
  it('empty buffer accepts a fresh cursor', () => {
    const r = store.getSince(0);
    assert.ok(!r.gap);
    assert.equal(r.events.length, 0);
  });
  it('empty buffer rejects a cursor from a prior server lifetime', () => {
    const r = store.getSince(42);
    assert.ok(r.gap);
    assert.equal(r.events.length, 0);
  });

  it('replayed notifications dropped during session/load', () => {
    session.replaying = true;
    proc.emit('notification', toolCall);
    proc.emit('notification', toolCall);
    assert.equal(store.head(), 0);
  });
  it('live notifications stored once replay finishes', () => {
    session.replaying = false;
    proc.emit('notification', toolCall);
    assert.equal(store.head(), 1);
  });

  // Turn status reaches the snapshot (mid-turn reload shows the stop button).
  it('record: idle before a turn', () => {
    assert.equal(session.turnState.get().turnStatus, 'idle');
  });
  it('record: turn_started sets turnStatus running (mid-turn refetch)', () => {
    session.record({ kind: 'turn_started', prompt: [] });
    assert.equal(session.turnState.get().turnStatus, 'running');
  });
  it('record: turn_ended returns to idle', () => {
    session.record({ kind: 'turn_ended', stopReason: 'end_turn' });
    assert.equal(session.turnState.get().turnStatus, 'idle');
  });
});

describe('SessionManager.replayHead (re-open mid-turn must not drop the prompt)', () => {
  let store: EventStore;
  let session: Session;
  let mgr: { replayHead(s: unknown, t: unknown): number };
  let evSeq: number;

  before(() => {
    const log = noopLogger();
    mgr = new SessionManager(log) as unknown as { replayHead(s: unknown, t: unknown): number };
    store = new EventStore('replayhead-test', log);
    session = new Session('replayhead-test', store, '/tmp');
    session.running = true;
    evSeq = session.record({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hello there' }] }).seq;
  });
  after(() => {
    store.dispose();
    try {
      fs.rmSync(path.join(config.casperDataDir, 'replayhead-test.events.jsonl'), { force: true });
    } catch {
      /* best effort */
    }
  });

  it('rewinds to replay an in-flight turn missing from hydrate', () => {
    assert.equal(mgr.replayHead(session, []), evSeq - 1);
  });
  it('no rewind when the prompt is already hydrated', () => {
    const hydrated = [{ type: 'message', message: { id: 'u1', role: 'user', text: 'hello there' } }];
    assert.equal(mgr.replayHead(session, hydrated), store.head());
  });
  it('uses head when no turn is in flight', () => {
    session.running = false;
    assert.equal(mgr.replayHead(session, []), store.head());
  });
});

describe('sidebar reorder (prompt floats the active session to the top)', () => {
  const mk = (id: string, updatedAt: string): SessionSummary =>
    ({ sessionId: id, title: id, cwd: '/', createdAt: updatedAt, updatedAt }) as SessionSummary;
  const list = [
    mk('a', '2026-07-16T10:00:00.000Z'),
    mk('b', '2026-07-16T09:00:00.000Z'),
    mk('c', '2026-07-16T08:00:00.000Z'),
  ];

  it('bumped session moves to the top', () => {
    const reordered = bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(reordered[0].sessionId, 'c');
  });
  it('the rest keep their relative order', () => {
    const reordered = bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(reordered.map((s) => s.sessionId).join(), 'c,a,b');
  });
  it('does not mutate the input array', () => {
    bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
    assert.equal(list[0].sessionId, 'a');
  });
  it('unknown session id leaves the order unchanged', () => {
    assert.equal(
      bumpSessionToTop(list, 'missing', '2026-07-16T12:00:00.000Z').map((s) => s.sessionId).join(),
      'a,b,c',
    );
  });
});

describe('transcript pagination (older-page window walks toward index 0)', () => {
  it('full page adjacent to the window', () => {
    const full = olderPageRequest(200, 80);
    assert.equal(full.offset, 120);
    assert.equal(full.limit, 80);
  });
  it('last partial page starts at 0', () => {
    const partial = olderPageRequest(50, 80);
    assert.equal(partial.offset, 0);
    assert.equal(partial.limit, 50);
  });
  it('exact page ends at index 0', () => {
    const exact = olderPageRequest(80, 80);
    assert.equal(exact.offset, 0);
    assert.equal(exact.limit, 80);
  });
  it('nothing older -> empty request', () => {
    assert.equal(olderPageRequest(0, 80).limit, 0);
  });
  it('pages tile down to zero', () => {
    let remaining = 200;
    const offsets: number[] = [];
    while (remaining > 0) {
      const { offset, limit } = olderPageRequest(remaining, 80);
      offsets.push(offset);
      remaining -= limit;
    }
    assert.equal(offsets.join(), '120,40,0');
    assert.equal(remaining, 0);
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

describe('realConfineToRoot (symlink-aware confinement)', () => {
  let root: string;
  let outside: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.symlinkSync(outside, path.join(root, 'escape'));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('symlink escaping root rejected', async () => {
    const escaped = await realConfineToRoot(root, path.join(root, 'escape', 'secret.txt'));
    assert.equal(escaped, null);
  });
  it('in-root file allowed', async () => {
    const inRoot = await realConfineToRoot(root, path.join(root, 'ok.txt'));
    assert.notEqual(inRoot, null);
  });
});
