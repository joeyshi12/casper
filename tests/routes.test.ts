// HTTP surface: path confinement, the routes, and how failures are reported.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CasperEvent,
  CasperEventPayload,
  DirListing,
  SessionDetail,
  SessionSummary,
} from '@casper/shared';
import Fastify from 'fastify';
import { useStore } from '../web/src/state/store.js';
import { config, parseConfigDoc, pickInt, pickString } from '../server/src/config.js';
import { AttemptLimiter } from '../server/src/util/rateLimit.js';
import { SessionManager, Session } from '../server/src/session/SessionManager.js';
import { describeError } from '../server/src/acp/errors.js';
import { registerFsRoutes } from '../server/src/routes/fs.js';
import { KiroProcess } from '../server/src/session/KiroProcess.js';
import {
  confineToRoot,
  isValidSessionId,
  isWithinRoot,
  realConfineToRoot,
} from '../server/src/util/paths.js';
import { classifyKind, looksBinary } from '../server/src/util/filekind.js';
import { noopLogger } from './helpers.js';
import {
  createDirWatchers,
  diffWatchSet,
  MAX_WATCHES,
} from '../server/src/ws/dirWatchers.js';

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

describe('GET /api/fs/dirs: reports what the typed path is', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof buildFsApp>>;

  const buildFsApp = async () => {
    const instance = Fastify();
    registerFsRoutes(instance);
    await instance.ready();
    return instance;
  };

  const dirsFor = async (p: string) => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/dirs', query: { path: p } });
    assert.equal(res.statusCode, 200, `dirs(${p}) -> ${res.statusCode}`);
    return res.json() as DirListing;
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-newcwd-'));
    fs.mkdirSync(path.join(root, 'exists'));
    fs.writeFileSync(path.join(root, 'a-file.txt'), 'x');
    app = await buildFsApp();
  });
  after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('an existing directory', async () => {
    const r = await dirsFor(path.join(root, 'exists'));
    assert.equal(r.targetKind, 'directory');
    assert.equal(r.target, path.join(root, 'exists'));
  });

  it('a path that does not exist yet - the sheet says it will be created', async () => {
    const missing = path.join(root, 'brand', 'new', 'folder');
    const r = await dirsFor(missing);
    assert.equal(r.targetKind, 'missing');
    assert.equal(r.target, missing);
  });

  it('a file, which create rejects rather than creating', async () => {
    const r = await dirsFor(path.join(root, 'a-file.txt'));
    assert.equal(r.targetKind, 'file');
  });

  it('reports the resolved absolute path so relative input is unambiguous', async () => {
    const r = await dirsFor('some-relative-name');
    assert.equal(r.target, path.resolve(config.defaultCwd, 'some-relative-name'));
  });
});

describe('createSession resolves a missing cwd by creating it', () => {
  let root: string;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-mkcwd-'));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('setSessionCwd creates the folder, including missing parents', async () => {
    const manager = new SessionManager(noopLogger());
    const target = path.join(root, 'deep', 'nested', 'work');
    assert.equal(fs.existsSync(target), false, 'starts absent');

    // The session does not exist, so this rejects - but resolveCwd runs first,
    // which is the step that creates the directory.
    await manager.setSessionCwd('no-such-session', target).catch(() => {});

    assert.equal(fs.existsSync(target), true, 'directory was created');
    assert.equal(fs.statSync(target).isDirectory(), true);
    manager.disposeAll();
  });
});

describe('failures explain themselves', () => {
  const bin = (script: string) => {
    const p = path.join(os.tmpdir(), `casper-fakekiro-${Date.now()}-${Math.random()}.sh`);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    return p;
  };

  it('a dying kiro reports what it printed, not just an exit code', async () => {
    const script = bin(`echo "Error: credentials have expired. Run 'kiro-cli login'." >&2\nexit 1`);
    const prev = config.kiroBin;
    config.kiroBin = script;
    try {
      const proc = new KiroProcess({ cwd: os.tmpdir() }, noopLogger());
      const err = await proc.initialize().then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err, 'initialize rejects when the process dies');
      assert.match(err.message, /exited with code 1/);
      assert.match(err.message, /credentials have expired/);
      // No ACP jargon: the reason reaches the user as a turn_error.
      assert.ok(!err.message.includes('ACP client closed'));
    } finally {
      config.kiroBin = prev;
      fs.rmSync(script, { force: true });
    }
  });

  it('a silent exit reads cleanly, with no dangling separator', async () => {
    const script = bin('exit 3');
    const prev = config.kiroBin;
    config.kiroBin = script;
    try {
      const proc = new KiroProcess({ cwd: os.tmpdir() }, noopLogger());
      const err = await proc.initialize().then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err);
      assert.equal(err.message, 'kiro-cli exited with code 3');
    } finally {
      config.kiroBin = prev;
      fs.rmSync(script, { force: true });
    }
  });

  it('a failed send keeps the reason on the message, and retry clears it', () => {
    useStore.getState().clearActive();
    useStore.getState().addPending('p1', 'hello');
    useStore.getState().markPendingFailed('p1', 'A turn is already running for this session');

    const failed = useStore.getState().pending.find((p) => p.id === 'p1');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error, 'A turn is already running for this session');

    // What retrySend does: back to sending, and the stale reason is dropped.
    useStore.setState((prev) => ({
      pending: prev.pending.map((p) =>
        p.id === 'p1' ? { ...p, status: 'sending' as const, error: undefined } : p,
      ),
    }));
    const retried = useStore.getState().pending.find((p) => p.id === 'p1');
    assert.equal(retried?.status, 'sending');
    assert.equal(retried?.error, undefined);
  });
});

describe('turn failures surface as system events, not assistant messages', () => {
  const turnError = (seq: number, message: string): CasperEvent => ({
    seq,
    sessionId: 's1',
    ts: new Date('2026-07-30T12:00:00Z').toISOString(),
    payload: { kind: 'turn_error', message } as CasperEventPayload,
  });

  const turnEnded = (seq: number): CasperEvent => ({
    seq,
    sessionId: 's1',
    ts: new Date('2026-07-30T12:00:01Z').toISOString(),
    payload: { kind: 'turn_ended', stopReason: 'end_turn' } as unknown as CasperEventPayload,
  });

  beforeEach(() => useStore.getState().clearActive());

  it('records a turn_error item rather than a fake assistant message', () => {
    useStore.getState().applyEvent(turnError(1, 'kiro-cli exited with code 1'));
    const items = useStore.getState().items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, 'turn_error');
    // The old behaviour attributed this to the model; make sure that's gone.
    assert.ok(!items.some((i) => i.type === 'message'));
    assert.ok(!JSON.stringify(items).includes('⚠️'));
  });

  it('keeps the server text verbatim for the raw details block', () => {
    const raw = "kiro-cli exited with code 1: Error: your credentials have expired. Run 'kiro-cli login'.";
    useStore.getState().applyEvent(turnError(1, raw));
    const item = useStore.getState().items[0]!;
    assert.equal(item.type === 'turn_error' && item.message, raw);
  });

  it('pins a session notice for a session-wide failure', () => {
    useStore.getState().applyEvent(turnError(1, 'Error: credentials have expired'));
    const notice = useStore.getState().sessionNotice;
    assert.ok(notice, 'notice is pinned');
    assert.equal(notice.title, "Kiro isn't authenticated");
    assert.match(notice.fix ?? '', /kiro-cli login/);
  });

  it('does not pin a notice for a one-off failure', () => {
    useStore.getState().applyEvent(turnError(1, 'A turn is already running for this session'));
    assert.equal(useStore.getState().sessionNotice, null);
    // ...but it's still in the transcript.
    assert.equal(useStore.getState().items[0]!.type, 'turn_error');
  });

  it('clears the notice once a turn gets through', () => {
    useStore.getState().applyEvent(turnError(1, 'Error: credentials have expired'));
    assert.ok(useStore.getState().sessionNotice);
    useStore.getState().applyEvent(turnEnded(2));
    assert.equal(useStore.getState().sessionNotice, null);
  });

  it('can be dismissed', () => {
    useStore.getState().applyEvent(turnError(1, 'Error: credentials have expired'));
    useStore.getState().dismissSessionNotice();
    assert.equal(useStore.getState().sessionNotice, null);
  });
});

describe('describeError (ACP error detail)', () => {
  it('leads with data, the only part that says what went wrong', () => {
    // Exactly what kiro answers a prompt for an unknown session with.
    const got = describeError({
      code: -32603,
      message: 'Internal error',
      data: 'No session found with id',
    });
    assert.equal(got, 'No session found with id (Internal error, code -32603)');
  });

  it('falls back to message when there is no data', () => {
    assert.equal(
      describeError({ code: -32601, message: 'Method not found' }),
      'Method not found (code -32601)',
    );
  });

  it('pulls the detail out of an object payload', () => {
    const got = describeError({
      code: -32603,
      message: 'Internal error',
      data: { message: 'model overloaded, retry later' },
    });
    assert.match(got, /model overloaded, retry later/);
  });

  it('tries the other keys agents use for the detail', () => {
    const got = describeError({
      code: -32603,
      message: 'Internal error',
      data: { reason: 'credentials expired' },
    });
    assert.match(got, /credentials expired/);
  });

  it('serialises an unrecognised object rather than dropping it', () => {
    const got = describeError({
      code: -32603,
      message: 'Internal error',
      data: { unexpected: 'shape', n: 7 },
    });
    assert.match(got, /unexpected/);
    assert.match(got, /shape/);
  });

  it('ignores null data instead of printing it', () => {
    const got = describeError({ code: -32603, message: 'Internal error', data: null });
    assert.equal(got, 'Internal error (code -32603)');
  });

  it('bounds a huge payload so it cannot flood the transcript', () => {
    const got = describeError({
      code: -32603,
      message: 'Internal error',
      data: 'x'.repeat(5000),
    });
    assert.ok(got.length < 2200, `got ${got.length} chars`);
    assert.match(got, /truncated/);
  });
});

describe('static file serving', () => {
  it('serves a file that appeared after registration', async () => {
    // wildcard: false snapshots the route table at registration, so a rebuild's new
    // hashed assets 404 until restart even though index.html points straight at them.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-static-'));
    fs.mkdirSync(path.join(root, 'assets'));
    const app = Fastify();
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root });
    await app.ready();

    fs.writeFileSync(path.join(root, 'assets', 'after-start.js'), 'x');
    const res = await app.inject({ method: 'GET', url: '/assets/after-start.js' });
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});

describe('login attempt limiter', () => {
  const WINDOW = 60_000;

  it('allows attempts up to the limit', () => {
    const l = new AttemptLimiter(3, WINDOW);
    for (let i = 0; i < 3; i++) {
      assert.equal(l.check('ip', 0).allowed, true);
      l.fail('ip', 0);
    }
    assert.equal(l.check('ip', 0).allowed, false);
  });

  it('reports how long to wait', () => {
    const l = new AttemptLimiter(1, WINDOW);
    l.fail('ip', 0);
    const d = l.check('ip', 30_000);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.retryAfterSeconds, 30);
  });

  it('forgives once the window passes', () => {
    const l = new AttemptLimiter(1, WINDOW);
    l.fail('ip', 0);
    assert.equal(l.check('ip', WINDOW - 1).allowed, false);
    assert.equal(l.check('ip', WINDOW).allowed, true);
  });

  it('keeps keys separate, so one client cannot lock out another', () => {
    const l = new AttemptLimiter(1, WINDOW);
    l.fail('a', 0);
    assert.equal(l.check('a', 0).allowed, false);
    assert.equal(l.check('b', 0).allowed, true);
  });

  it('clears the count on success', () => {
    const l = new AttemptLimiter(2, WINDOW);
    l.fail('ip', 0);
    l.succeed('ip');
    l.fail('ip', 0);
    assert.equal(l.check('ip', 0).allowed, true);
  });

  it('does not grow without bound as addresses come and go', () => {
    const l = new AttemptLimiter(1, WINDOW);
    for (let i = 0; i < 500; i++) l.fail(`ip-${i}`, 0);
    // One live key after the window rolls over: the rest are pruned on access.
    l.fail('fresh', WINDOW + 1);
    const size = (l as unknown as { hits: Map<string, unknown> }).hits.size;
    assert.equal(size, 1);
  });
});

describe('directory watch set', () => {
  it('starts and stops only what changed', () => {
    const d = diffWatchSet(['', 'src', 'src/util'], ['', 'src', 'tests']);
    assert.deepEqual(d.add, ['tests']);
    assert.deepEqual(d.remove, ['src/util']);
  });

  it('is a no-op when the set is unchanged', () => {
    const d = diffWatchSet(['', 'src'], ['src', '']);
    assert.deepEqual([d.add, d.remove], [[], []]);
  });

  // A client could otherwise ask the server to hold thousands of inotify handles.
  it('caps how many paths a client can ask for', () => {
    const many = Array.from({ length: MAX_WATCHES + 20 }, (_, i) => `d${i}`);
    assert.equal(diffWatchSet([], many).add.length, MAX_WATCHES);
  });
});

describe('directory watchers', () => {
  it('reports the directory that changed, and nothing else', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-watch-'));
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    const seen: string[] = [];
    const watchers = createDirWatchers({
      resolve: async (rel) => path.join(root, rel),
      onChange: (rel) => seen.push(rel),
    });
    try {
      await watchers.sync(['a', 'b']);
      assert.deepEqual(watchers.watching().sort(), ['a', 'b']);

      fs.writeFileSync(path.join(root, 'a', 'new.ts'), 'x');
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(seen, ['a'], `expected only a, got ${JSON.stringify(seen)}`);

      // Collapsing a folder stops its watch, so later writes there are silent.
      await watchers.sync(['b']);
      assert.deepEqual(watchers.watching(), ['b']);
      fs.writeFileSync(path.join(root, 'a', 'another.ts'), 'x');
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(seen, ['a']);
    } finally {
      watchers.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('coalesces a burst into one report', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-watch-'));
    const seen: string[] = [];
    const watchers = createDirWatchers({
      resolve: async (rel) => path.join(root, rel),
      onChange: (rel) => seen.push(rel),
    });
    try {
      await watchers.sync(['']);
      for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(seen.length, 1, `expected one report, got ${seen.length}`);
    } finally {
      watchers.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores a path that does not resolve, rather than throwing', async () => {
    const watchers = createDirWatchers({ resolve: async () => null, onChange: () => {} });
    await watchers.sync(['../../etc']);
    assert.deepEqual(watchers.watching(), []);
    watchers.close();
  });
});
