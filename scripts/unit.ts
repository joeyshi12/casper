// Unit checks for the pure fold logic (no processes or network).
// Run with: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { CasperEventPayload } from '@casper/shared';
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
import type { SessionSummary } from '@casper/shared';
import {
  ATTACHMENTS_PREFIX,
  attachmentPaths,
  imageAttachmentPaths,
  stripAttachmentsLine,
} from '@casper/shared';

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ${msg}`);
    failures++;
  }
}

// A representative stream of events across one full turn.
const events: CasperEventPayload[] = [
  { kind: 'commands_available', params: { sessionId: 's', commands: [{ name: '/agent' }] } },
  { kind: 'mcp_health', params: { sessionId: 's', serverName: 'builder-mcp' }, ok: true },
  { kind: 'mcp_health', params: { sessionId: 's', serverName: 'pippin-mcp', error: 'boom' }, ok: false },
  { kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] },
  { kind: 'session_update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } },
  { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 15.9, meteringUsage: [{ value: 0.04, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 1916 } },
  { kind: 'turn_ended', stopReason: 'end_turn' },
  // A second turn adds more credits.
  { kind: 'turn_started', prompt: [{ type: 'text', text: 'again' }] },
  { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 22.1, meteringUsage: [{ value: 0.06, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 3000 } },
  { kind: 'turn_ended', stopReason: 'end_turn' },
];

const ts = new TurnState();
for (const e of events) ts.apply(e);
const snap = ts.get();

check(Math.abs(snap.creditsSpent - 0.1) < 1e-9, `cumulative credits accumulate across turns (${snap.creditsSpent.toFixed(4)})`);
check(Math.abs(snap.lastTurnCredits - 0.06) < 1e-9, `lastTurnCredits reflects most recent turn (${snap.lastTurnCredits})`);
check(snap.contextUsagePercentage === 22.1, `contextUsagePercentage takes latest value (${snap.contextUsagePercentage})`);
check(snap.lastTurnDurationMs === 3000, `lastTurnDurationMs takes latest value (${snap.lastTurnDurationMs})`);
check(snap.turnStatus === 'idle', 'turnStatus returns to idle after turn_ended');
check(snap.mcpServers.length === 2, 'both MCP servers tracked');
check(snap.mcpServers.find((m) => m.serverName === 'pippin-mcp')?.status === 'failed', 'failed MCP server marked failed');
check(snap.mcpServers.find((m) => m.serverName === 'builder-mcp')?.status === 'initialized', 'healthy MCP server marked initialized');
check(snap.availableCommands.length === 1, 'available commands captured');

// Compaction: 'started' flips compacting on, 'completed' clears it (context
// changes arrive separately via metadata).
const tsc = new TurnState();
check(tsc.get().compacting === false, 'compacting defaults to false');
tsc.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'started' }, summary: null } });
check(tsc.get().compacting === true, 'compaction started sets compacting true');
tsc.apply({ kind: 'compaction', params: { sessionId: 's', status: { type: 'completed' }, summary: 'sum' } });
check(tsc.get().compacting === false, 'compaction completed clears compacting');

// Seed (resume path) should set cumulative baseline.
const ts2 = new TurnState();
ts2.seed(1.5, 40);
check(ts2.get().creditsSpent === 1.5, 'seed sets cumulative credits on resume');
check(ts2.get().contextUsagePercentage === 40, 'seed sets context usage on resume');

// A crash mid-turn (process_exited) must reset turnStatus to idle, so a REST
// refetch after a crash doesn't report a stuck 'running' turn.
const ts3 = new TurnState();
ts3.apply({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] });
check(ts3.get().turnStatus === 'running', 'turnStatus running after turn_started');
ts3.apply({ kind: 'process_exited', code: 1, signal: null });
check(ts3.get().turnStatus === 'idle', 'process_exited resets turnStatus to idle');

// oauth_request accumulates a prompt entry.
const ts4 = new TurnState();
ts4.apply({ kind: 'oauth_request', params: { sessionId: 's', serverName: 'gh', url: 'https://x' } });
check(ts4.get().oauthPrompts.length === 1, 'oauth_request accumulates an oauth prompt');

// Path confinement (security-critical: bounds all file-serving endpoints).
check(isWithinRoot('/home/joey', '/home/joey/a/b'), 'isWithinRoot: nested path allowed');
check(isWithinRoot('/home/joey', '/home/joey'), 'isWithinRoot: root itself allowed');
check(!isWithinRoot('/home/joey', '/home/joeyx/x'), 'isWithinRoot: prefix-match blocked');
check(isWithinRoot('/', '/etc/passwd'), 'isWithinRoot: fs root contains everything');
check(confineToRoot('/home/joey', 'a/b') === '/home/joey/a/b', 'confineToRoot: relative resolved');
check(confineToRoot('/home/joey', '../etc') === null, 'confineToRoot: traversal blocked');
check(confineToRoot('/home/joey', '/etc/passwd') === null, 'confineToRoot: out-of-root absolute blocked');
check(isValidSessionId('ec0afd54-d34c-4da8-ac92-051841321930'), 'isValidSessionId: uuid accepted');
check(!isValidSessionId('../../etc/passwd'), 'isValidSessionId: traversal rejected');
check(!isValidSessionId('a/b'), 'isValidSessionId: separator rejected');
check(!isValidSessionId('.'), 'isValidSessionId: dot rejected');

// Upload classification decides how a file is surfaced to the agent.
check(classifyKind('photo.PNG') === 'image', 'classifyKind: image by extension (case-insensitive)');
check(classifyKind('notes.md') === 'text', 'classifyKind: markdown is text');
check(classifyKind('main.rs') === 'text', 'classifyKind: source code is text');
check(classifyKind('sample.exe') === 'binary', 'classifyKind: exe is binary');
check(classifyKind('archive.tar.gz') === 'binary', 'classifyKind: gzip is binary');
check(classifyKind('noext') === 'binary', 'classifyKind: no extension defaults to binary');

// Content sniff rescues extensionless/dotfile text that the preview route
// would otherwise hexdump (e.g. .gitignore, .nvmrc).
check(!looksBinary(Buffer.from('node_modules\ndist\n')), 'looksBinary: gitignore-style text is text');
check(!looksBinary(Buffer.from('20.11.0\n')), 'looksBinary: nvmrc-style text is text');
check(!looksBinary(Buffer.from('')), 'looksBinary: empty file is text');
check(!looksBinary(Buffer.from('héllo café\tτ\n', 'utf8')), 'looksBinary: utf-8 text is text');
check(looksBinary(Buffer.from([0x00, 0x01, 0x02, 0x00])), 'looksBinary: NUL byte marks binary');
check(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])), 'looksBinary: PNG header marks binary');
check(looksBinary(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'looksBinary: UTF-16 LE BOM marks binary');
// Control-char ratio threshold is > 0.3: 3/10 stays text, 4/10 is binary.
check(
  !looksBinary(Buffer.from([0x01, 0x01, 0x01, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41])),
  'looksBinary: exactly 30% control chars is text',
);
check(
  looksBinary(Buffer.from([0x01, 0x01, 0x01, 0x01, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41])),
  'looksBinary: 40% control chars is binary',
);

// Attachment line: the compact "Attached files:" line drives image thumbnails
// and is stripped from the displayed bubble.
{
  const msg = `${ATTACHMENTS_PREFIX}.casper/uploads/a.png, .casper/uploads/notes.txt\nplease review`;
  const paths = attachmentPaths(msg);
  check(paths.length === 2 && paths[0] === '.casper/uploads/a.png', 'attachmentPaths: parses both paths');
  check(
    imageAttachmentPaths(msg).join() === '.casper/uploads/a.png',
    'imageAttachmentPaths: keeps only images',
  );
  check(stripAttachmentsLine(msg) === 'please review', 'stripAttachmentsLine: removes the attachments line');
  check(attachmentPaths('just a message').length === 0, 'attachmentPaths: none when absent');
  check(
    stripAttachmentsLine('hello world') === 'hello world',
    'stripAttachmentsLine: unchanged without the line',
  );
}

// Regression: a pasted-image-plus-text message. The composer terminates the
// attachments line with '\n', so the store's turn_started echo and
// hydrateTranscript (which join prompt text blocks with '', not '\n') still
// recover the typed text and the image path - otherwise the whole line-based
// strip swallowed the message and the bubble rendered empty.
{
  const attLine = `${ATTACHMENTS_PREFIX}.casper/uploads/pasted.png\n`;
  const joinedEmpty = [attLine, 'look at this'].join('');
  check(
    stripAttachmentsLine(joinedEmpty) === 'look at this',
    'attachments+text: typed text survives an empty-string join',
  );
  check(
    imageAttachmentPaths(joinedEmpty).join() === '.casper/uploads/pasted.png',
    'attachments+text: image path parsed after an empty-string join',
  );
}

// Regression: kiro replays the entire conversation as notifications during
// session/load. The transcript is already hydrated from disk, so those must be
// dropped while Session.replaying is set - otherwise the chat floods with
// duplicate tool calls. Also: turn lifecycle events must reach turnState via
// Session.record, so a client refetching mid-turn sees turnStatus 'running'
// (not a stale 'idle' that shows the send button instead of stop).
{
  const noopLog = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
    child() {
      return noopLog;
    },
  } as unknown as import('../server/src/util/logger.js').Logger;
  const mgr = new SessionManager(noopLog) as unknown as {
    wire(s: unknown, proc: unknown): void;
  };
  const store = new EventStore('replay-regression-test', noopLog);
  const session = new Session('replay-regression-test', store, '/tmp');
  const proc = new EventEmitter();
  mgr.wire(session, proc);
  const toolCall = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'x' } },
  };

  // Replay gating.
  session.replaying = true;
  proc.emit('notification', toolCall);
  proc.emit('notification', toolCall);
  check(store.head() === 0, 'wire: replayed notifications dropped during session/load');
  session.replaying = false;
  proc.emit('notification', toolCall);
  check(store.head() === 1, 'wire: live notifications stored once replay finishes');

  // Turn status reaches the snapshot (mid-turn reload shows the stop button).
  check(session.turnState.get().turnStatus === 'idle', 'record: idle before a turn');
  session.record({ kind: 'turn_started', prompt: [] });
  check(
    session.turnState.get().turnStatus === 'running',
    'record: turn_started sets turnStatus running (mid-turn refetch)',
  );
  session.record({ kind: 'turn_ended', stopReason: 'end_turn' });
  check(session.turnState.get().turnStatus === 'idle', 'record: turn_ended returns to idle');

  store.dispose();
  try {
    fs.rmSync(path.join(config.casperDataDir, 'replay-regression-test.events.jsonl'), {
      force: true,
    });
  } catch {
    /* best effort */
  }
}

// Regression: re-opening a session mid-turn must not drop the in-flight user
// message. kiro persists a turn only at completion, so the hydrated transcript
// lacks it; replayHead rewinds the cursor to replay the in-flight turn_started.
{
  const noopLog = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
    child() {
      return noopLog;
    },
  } as unknown as import('../server/src/util/logger.js').Logger;
  const mgr = new SessionManager(noopLog) as unknown as {
    replayHead(s: unknown, t: unknown): number;
  };
  const store = new EventStore('replayhead-test', noopLog);
  const session = new Session('replayhead-test', store, '/tmp');
  session.running = true;
  const ev = session.record({ kind: 'turn_started', prompt: [{ type: 'text', text: 'hello there' }] });

  check(
    mgr.replayHead(session, []) === ev.seq - 1,
    'replayHead: rewinds to replay an in-flight turn missing from hydrate',
  );
  const hydrated = [{ type: 'message', message: { id: 'u1', role: 'user', text: 'hello there' } }];
  check(
    mgr.replayHead(session, hydrated) === store.head(),
    'replayHead: no rewind when the prompt is already hydrated',
  );
  session.running = false;
  check(
    mgr.replayHead(session, []) === store.head(),
    'replayHead: uses head when no turn is in flight',
  );

  store.dispose();
  try {
    fs.rmSync(path.join(config.casperDataDir, 'replayhead-test.events.jsonl'), { force: true });
  } catch {
    /* best effort */
  }
}

// Sidebar reorder: sending a prompt floats the active session to the top by
// stamping its updatedAt and re-sorting (same key/order as the server).
{
  const mk = (id: string, updatedAt: string): SessionSummary =>
    ({ sessionId: id, title: id, cwd: '/', createdAt: updatedAt, updatedAt }) as SessionSummary;
  const list = [
    mk('a', '2026-07-16T10:00:00.000Z'),
    mk('b', '2026-07-16T09:00:00.000Z'),
    mk('c', '2026-07-16T08:00:00.000Z'),
  ];
  const after = bumpSessionToTop(list, 'c', '2026-07-16T11:00:00.000Z');
  check(after[0].sessionId === 'c', 'reorder: bumped session moves to the top');
  check(
    after.map((s) => s.sessionId).join() === 'c,a,b',
    'reorder: the rest keep their relative order',
  );
  check(list[0].sessionId === 'a', 'reorder: does not mutate the input array');
  check(
    bumpSessionToTop(list, 'missing', '2026-07-16T12:00:00.000Z').map((s) => s.sessionId).join() ===
      'a,b,c',
    'reorder: unknown session id leaves the order unchanged',
  );
}

// Transcript pagination: the older-page window walks backward toward index 0,
// fetching the page adjacent to the loaded window first, and never underflows.
{
  const full = olderPageRequest(200, 80);
  check(full.offset === 120 && full.limit === 80, 'pagination: full page adjacent to the window');
  const partial = olderPageRequest(50, 80);
  check(partial.offset === 0 && partial.limit === 50, 'pagination: last partial page starts at 0');
  const exact = olderPageRequest(80, 80);
  check(exact.offset === 0 && exact.limit === 80, 'pagination: exact page ends at index 0');
  check(olderPageRequest(0, 80).limit === 0, 'pagination: nothing older -> empty request');
  // Walking backward from 200 in pages of 80 covers [120,200),[40,120),[0,40).
  let remaining = 200;
  const offsets: number[] = [];
  while (remaining > 0) {
    const { offset, limit } = olderPageRequest(remaining, 80);
    offsets.push(offset);
    remaining -= limit;
  }
  check(offsets.join() === '120,40,0' && remaining === 0, 'pagination: pages tile down to zero');
}


async function realpathTests(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const escaped = await realConfineToRoot(root, path.join(root, 'escape', 'secret.txt'));
    check(escaped === null, 'realConfineToRoot: symlink escaping root rejected');
    const inRoot = await realConfineToRoot(root, path.join(root, 'ok.txt'));
    check(inRoot !== null, 'realConfineToRoot: in-root file allowed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

void realpathTests().then(() => {
  if (failures > 0) {
    console.error(`\n❌ ${failures} unit check(s) failed.`);
    process.exit(1);
  }
  console.log('\n🎉 Unit checks passed.');
});
