// HTTP surface: path confinement, the routes, and how failures are reported.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CasperEvent,
  CasperEventPayload,
  DirListing,
  ServerMessage,
  SessionDetail,
  SessionSummary,
  TreeResponse,
  UploadResponse,
} from '@casper/shared';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { useStore } from '../web/src/state/store.js';
import { config, parseConfigDoc, pickInt, pickString } from '../server/src/config.js';
import { AttemptLimiter } from '../server/src/util/rateLimit.js';
import { SessionManager, Session } from '../server/src/session/SessionManager.js';
import { describeError } from '../server/src/acp/errors.js';
import { registerFsRoutes } from '../server/src/routes/fs.js';
import { registerUploadRoutes } from '../server/src/routes/uploads.js';
import { registerSessionRoutes } from '../server/src/routes/sessions.js';
import { registerWorkspaceRoutes } from '../server/src/routes/workspace.js';
import { KiroProcess } from '../server/src/session/KiroProcess.js';
import { listAgents, invalidateAgents } from '../server/src/session/agents.js';
import {
  confineToRoot,
  isValidSessionId,
  isWithinRoot,
  realConfineToRoot,
} from '../server/src/util/paths.js';
import { classifyKind, looksBinary } from '../server/src/util/filekind.js';
import { closeDb } from '../server/src/session/db.js';
import {
  classifyDirent,
  resolveAbsolutePath,
  resolveSessionPath,
} from '../server/src/util/confinedFile.js';
import { EventStore } from '../server/src/session/EventStore.js';
import { handleConnection, type GatewaySessions } from '../server/src/ws/gateway.js';
import { noopLogger } from './helpers.js';
import {
  createDirWatchers,
  diffWatchSet,
  MAX_WATCHES,
} from '../server/src/ws/dirWatchers.js';

// Each test file gets its own data directory. The runner gives each file its own process,
// so anything sharing one casper.db contends for its write lock - "database is locked" on a
// loaded CI box. Set before the first db() call, which is what opens it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-data-routes-'));
(config as { casperDataDir: string }).casperDataDir = dataDir;
closeDb();

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
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

  // .kiro is the folder the reload feature exists to re-read, and it used to be
  // unbrowsable: typeable, but never offered.
  it('lists dot-directories, after the ordinary ones', async () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-dots-'));
    for (const name of ['.kiro', '.config', 'zebra', 'apple']) {
      fs.mkdirSync(path.join(box, name));
    }
    try {
      const r = await dirsFor(box + path.sep);
      assert.deepEqual(
        r.entries.map((e) => path.basename(e)),
        ['apple', 'zebra', '.config', '.kiro'],
        'ordinary names first, alphabetical within each group',
      );
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });

  it('filters dot-directories by prefix like any other', async () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-dots2-'));
    fs.mkdirSync(path.join(box, '.kiro'));
    fs.mkdirSync(path.join(box, '.config'));
    try {
      const r = await dirsFor(path.join(box, '.k'));
      assert.deepEqual(r.entries.map((e) => path.basename(e)), ['.kiro']);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });

  it('still lists directories only, dot or not', async () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-dots3-'));
    fs.mkdirSync(path.join(box, '.adir'));
    fs.writeFileSync(path.join(box, '.afile'), 'x');
    try {
      const r = await dirsFor(box + path.sep);
      assert.deepEqual(r.entries.map((e) => path.basename(e)), ['.adir']);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });
});

describe('createSession resolves a missing cwd by creating it', () => {
  let root: string;
  let dataDir: string;
  const origData = config.casperDataDir;
  // A manager reaches the store, so this points somewhere disposable: AGENTS.md forbids a
  // test writing into the developer's real ~/.casper, and it did until this was added.
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-mkcwd-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-mkcwd-data-'));
    (config as { casperDataDir: string }).casperDataDir = dataDir;
    closeDb();
  });
  after(() => {
    closeDb();
    (config as { casperDataDir: string }).casperDataDir = origData;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

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

// The picker is only right if the list is re-read: agents are created while the
// server runs, and the list used to be cached for its whole lifetime.
describe('the agent list does not go stale', () => {
  const fakeAgentBin = (log: string) => {
    const p = path.join(os.tmpdir(), `casper-agentbin-${Date.now()}-${Math.random()}.sh`);
    fs.writeFileSync(
      p,
      `#!/usr/bin/env bash\necho run >> ${log}\necho "  from-disk   Global  an agent that appeared later" >&2\n`,
      { mode: 0o755 },
    );
    return p;
  };

  it('re-reads after an invalidation, and answers from cache in between', async () => {
    const log = path.join(os.tmpdir(), `casper-agentruns-${Date.now()}.log`);
    fs.writeFileSync(log, '');
    const script = fakeAgentBin(log);
    const prev = config.kiroBin;
    config.kiroBin = script;
    const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;
    try {
      invalidateAgents();
      const first = await listAgents();
      assert.ok(
        first.some((a) => a.id === 'from-disk'),
        'an agent kiro reports should reach the picker',
      );
      assert.equal(runs(), 1);

      // Within the TTL: served from cache, so opening a picker doesn't spawn kiro.
      await listAgents();
      assert.equal(runs(), 1);

      // A reload says the world changed, so the next read goes back to kiro.
      invalidateAgents();
      await listAgents();
      assert.equal(runs(), 2);
    } finally {
      config.kiroBin = prev;
      invalidateAgents();
      fs.rmSync(script, { force: true });
      fs.rmSync(log, { force: true });
    }
  });

  it('always includes the built-in agents, even when kiro reports nothing', async () => {
    const prev = config.kiroBin;
    config.kiroBin = path.join(os.tmpdir(), 'casper-no-such-binary');
    try {
      invalidateAgents();
      const ids = (await listAgents()).map((a) => a.id);
      assert.ok(ids.includes('kiro_default'));
    } finally {
      config.kiroBin = prev;
      invalidateAgents();
    }
  });

  // kiro's table has drifted: 2.19 prints its own agents as (Built-in) where 2.11 used
  // Global/Workspace/Local. The old parser required one of those three words, so on 2.19 it
  // silently dropped every built-in and the picker fell back to a hardcoded list that had
  // itself gone stale - offering kiro_guide, which is gone, and hiding kiro_help.
  const agentBin = (table: string) => {
    const p = path.join(os.tmpdir(), `casper-agentlist-${Date.now()}-${Math.random()}.sh`);
    // The table goes to stderr, which is where kiro prints it.
    fs.writeFileSync(p, `#!/usr/bin/env bash\ncat >&2 <<'TABLE'\n${table}\nTABLE\n`, {
      mode: 0o755,
    });
    return p;
  };

  const idsFrom = async (table: string) => {
    const prev = config.kiroBin;
    const script = agentBin(table);
    config.kiroBin = script;
    try {
      invalidateAgents();
      return (await listAgents()).map((a) => a.id);
    } finally {
      config.kiroBin = prev;
      invalidateAgents();
      fs.rmSync(script, { force: true });
    }
  };

  it("reads kiro 2.19's table, where built-ins are marked (Built-in)", async () => {
    const ids = await idsFrom(
      [
        'Workspace: ~/proj/.kiro/agents',
        'Global:    ~/.kiro/agents',
        '',
        '* kiro_default    (Built-in)    Default agent',
        '  casper          Global        Casper - a web interface',
        '  kiro_help       (Built-in)    Help agent',
      ].join('\n'),
    );
    assert.deepEqual(ids, ['kiro_default', 'casper', 'kiro_help']);
  });

  it("still reads kiro 2.11's table, which had no (Built-in) column", async () => {
    const ids = await idsFrom(
      ['* kiro_default   Global     Default agent', '  casper         Global     A web interface'].join(
        '\n',
      ),
    );
    assert.deepEqual(ids, ['kiro_default', 'casper']);
  });

  it('does not mistake the "Global: <path>" header for an agent', async () => {
    const ids = await idsFrom(
      ['Global:    ~/.kiro/agents', 'Workspace: ~/proj/.kiro/agents', '', '  casper    Global    x'].join(
        '\n',
      ),
    );
    assert.deepEqual(ids, ['casper'], 'the header lines are not rows');
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
    useStore.getState().addPending({ id: 'p1', text: 'hello', content: [{ type: 'text', text: 'hello' }] });
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

// The predicates above are the primitives; these cover the sequence the file
// routes actually run - lexical confine, then symlink confine, then stat, then
// the kind check - and the status each step answers with.
describe('confined file access (the sequence every file route runs)', () => {
  let cwd: string;
  let outside: string;
  let fileRoot: string;

  const sessions = { getSessionCwd: async () => cwd };
  const noSession = {
    getSessionCwd: async (): Promise<string> => {
      throw new Error('Session not found');
    },
  };

  before(() => {
    fileRoot = config.fileRoot;
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-ws-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-outside-')));
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(cwd, 'sub'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    fs.symlinkSync(outside, path.join(cwd, 'link-out'));
    fs.symlinkSync(path.join(cwd, 'nowhere'), path.join(cwd, 'broken'));
  });

  after(() => {
    config.fileRoot = fileRoot;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a session that does not exist is 404, before any path work', async () => {
    const r = await resolveSessionPath(noSession, 'nope', 'a.txt', 'file');
    assert.deepEqual(r, { ok: false, status: 404, error: 'Session not found' });
  });

  it('download and preview require a path; the tree does not', async () => {
    const asFile = await resolveSessionPath(sessions, 's', '', 'file');
    assert.deepEqual(asFile, { ok: false, status: 400, error: 'path parameter is required' });

    const asDir = await resolveSessionPath(sessions, 's', '', 'directory');
    assert.ok(asDir.ok && asDir.real === cwd, 'empty path lists the workspace itself');
  });

  it('traversal out of the workspace is 400, not 404', async () => {
    const r = await resolveSessionPath(sessions, 's', '../etc/passwd', 'file');
    assert.deepEqual(r, { ok: false, status: 400, error: 'Invalid path' });
  });

  it('a leading slash is stripped rather than read as absolute', async () => {
    const r = await resolveSessionPath(sessions, 's', '//a.txt', 'file');
    assert.ok(r.ok && r.real === path.join(cwd, 'a.txt'));
    assert.ok(r.ok && r.relative === 'a.txt');
  });

  it('a missing file is 404 and a directory asked for as a file is 400', async () => {
    const missing = await resolveSessionPath(sessions, 's', 'gone.txt', 'file');
    assert.deepEqual(missing, { ok: false, status: 404, error: 'File not found' });

    const dir = await resolveSessionPath(sessions, 's', 'sub', 'file');
    assert.deepEqual(dir, { ok: false, status: 400, error: 'Path is not a file' });
  });

  it('a file asked for as a directory 404s the way readdir would have', async () => {
    const r = await resolveSessionPath(sessions, 's', 'a.txt', 'directory');
    assert.deepEqual(r, { ok: false, status: 404, error: 'Directory not found' });
  });

  // The lexical root (the workspace) and the real root (fileRoot) are separate
  // on purpose: a project may symlink to somewhere else the user can read.
  it('a symlink leaving the workspace but staying inside fileRoot is served', async () => {
    const r = await resolveSessionPath(sessions, 's', 'link-out/secret.txt', 'file');
    assert.ok(r.ok, 'expected the symlinked file to resolve');
    assert.equal(r.real, path.join(outside, 'secret.txt'));
  });

  it('the same symlink is refused once fileRoot no longer contains its target', async () => {
    config.fileRoot = cwd;
    try {
      const r = await resolveSessionPath(sessions, 's', 'link-out/secret.txt', 'file');
      assert.deepEqual(r, { ok: false, status: 404, error: 'File not found' });
    } finally {
      config.fileRoot = fileRoot;
    }
  });

  it('a deleted workspace explains itself instead of saying "not found"', async () => {
    const doomed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-gone-')));
    fs.rmSync(doomed, { recursive: true, force: true });
    const r = await resolveSessionPath(
      { getSessionCwd: async () => doomed },
      's',
      '',
      'directory',
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /Workspace folder no longer exists/);
  });

  it('absolute paths answer 403 outside the roots and 404 when missing', async () => {
    config.fileRoot = cwd;
    try {
      const escaped = await resolveAbsolutePath(path.join(outside, 'secret.txt'), 'file');
      assert.deepEqual(escaped, { ok: false, status: 403, error: 'Path outside allowed root' });

      const missing = await resolveAbsolutePath(path.join(cwd, 'gone.txt'), 'file');
      assert.deepEqual(missing, { ok: false, status: 404, error: 'File not found' });

      const found = await resolveAbsolutePath(path.join(cwd, 'a.txt'), 'file');
      assert.ok(found.ok && found.stat.size === 5);
    } finally {
      config.fileRoot = fileRoot;
    }
  });

  // Uploads live in the data directory, so a narrowed fileRoot must not hide
  // them - and the symlink check has to use the same pair of roots to match.
  it('the data directory stays reachable when fileRoot is narrowed', async () => {
    const upload = path.join(config.casperDataDir, 'confine-probe.txt');
    config.fileRoot = cwd;
    try {
      fs.mkdirSync(config.casperDataDir, { recursive: true });
      fs.writeFileSync(upload, 'x');
      const r = await resolveAbsolutePath(upload, 'file');
      assert.ok(r.ok, 'expected a file under casperDataDir to resolve');
    } finally {
      config.fileRoot = fileRoot;
      fs.rmSync(upload, { force: true });
    }
  });

  describe('directory entries', () => {
    const entryNamed = async (name: string, roots = [config.fileRoot]) => {
      const dirents = await fsp.readdir(cwd, { withFileTypes: true });
      const entry = dirents.find((d) => d.name === name);
      assert.ok(entry, `no dirent named ${name}`);
      return classifyDirent(cwd, entry, roots);
    };

    it('a file and a directory are classified as themselves', async () => {
      assert.deepEqual(await entryNamed('a.txt'), {
        kind: 'file',
        real: path.join(cwd, 'a.txt'),
      });
      assert.deepEqual(await entryNamed('sub'), {
        kind: 'directory',
        real: path.join(cwd, 'sub'),
      });
    });

    // Dirent.isDirectory() is false for a symlink even when it points at one.
    it('a symlink is classified by what it points at, and reports the target', async () => {
      assert.deepEqual(await entryNamed('link-out'), { kind: 'directory', real: outside });
    });

    it('a broken symlink is skipped', async () => {
      assert.equal(await entryNamed('broken'), null);
    });

    it('a symlink whose target escapes the roots is skipped', async () => {
      assert.equal(await entryNamed('link-out', [cwd]), null);
    });
  });
});

describe('ws gateway connection', () => {
  // A socket double: records what the server sent and lets a test push messages
  // in. Satisfies GatewaySocket structurally, so no casting through the type.
  const fakeSocket = () => {
    const sent: ServerMessage[] = [];
    const listeners: { message?: (raw: Buffer) => void; pong?: () => void; close?: () => void } =
      {};
    let closed: { code?: number; reason?: string } | null = null;
    return {
      sent,
      closed: () => closed,
      readyState: 1,
      OPEN: 1,
      send: (data: string) => sent.push(JSON.parse(data) as ServerMessage),
      close: (code?: number, reason?: string) => {
        closed = { code, reason };
      },
      terminate: () => {},
      ping: () => {},
      on(event: 'message' | 'pong' | 'close', cb: (raw: Buffer) => void) {
        listeners[event] = cb as never;
        return this;
      },
      deliver: (msg: unknown) => listeners.message?.(Buffer.from(JSON.stringify(msg))),
      deliverRaw: (raw: string) => listeners.message?.(Buffer.from(raw)),
      hangUp: () => listeners.close?.(),
    };
  };

  const stubSessions = (store: EventStore, over: Partial<GatewaySessions> = {}) => {
    const calls: string[] = [];
    const sessions: GatewaySessions & { calls: string[] } = {
      calls,
      ensureOpen: async () => ({}),
      getStore: () => store,
      onEvent: () => () => calls.push('unsubscribed'),
      getSessionCwd: async () => os.tmpdir(),
      runPrompt: async () => calls.push('runPrompt'),
      cancel: () => calls.push('cancel'),
      setMode: async () => calls.push('setMode'),
      setModel: async () => calls.push('setModel'),
      execCommand: async () => calls.push('execCommand'),
      ...over,
    };
    return sessions;
  };

  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('replays only what the client has not seen, then says it is caught up', async () => {
    const store = new EventStore('s1');
    for (let i = 0; i < 3; i++) {
      store.append({ kind: 'turn_ended', stopReason: 'end_turn' } as unknown as CasperEventPayload);
    }
    const socket = fakeSocket();
    handleConnection(socket, stubSessions(store), 's1', 2);
    await settle();

    const seqs = socket.sent
      .filter((m): m is Extract<ServerMessage, { type: 'event' }> => m.type === 'event')
      .map((m) => m.event.seq);
    assert.deepEqual(seqs, [3], 'events at or before the cursor must not be resent');
    assert.deepEqual(socket.sent.at(-1), { type: 'replay_complete', head: 3 });
  });

  it('tells a client whose cursor predates the buffer to resync', async () => {
    // After a restart the buffer is empty but the client still holds a cursor
    // from the previous lifetime: those events are gone, so it must refetch.
    const store = new EventStore('s1');
    const socket = fakeSocket();
    handleConnection(socket, stubSessions(store), 's1', 7);
    await settle();
    assert.equal(socket.sent[0]?.type, 'resync');
    assert.deepEqual(socket.sent.at(-1), { type: 'replay_complete', head: 0 });
  });

  it('a control action is acknowledged, and a failure carries the reason', async () => {
    const store = new EventStore('s1');
    const socket = fakeSocket();
    handleConnection(socket, stubSessions(store), 's1', 0);
    await settle();

    socket.deliver({ type: 'set_model', modelId: 'm1' });
    await settle();
    assert.deepEqual(socket.sent.at(-1), { type: 'ack', action: 'set_model', ok: true });

    const failing = fakeSocket();
    handleConnection(
      failing,
      stubSessions(store, {
        runPrompt: async () => {
          throw new Error('no capacity');
        },
      }),
      's1',
      0,
    );
    await settle();
    failing.deliver({ type: 'prompt', content: [] });
    await settle();
    assert.deepEqual(failing.sent.at(-1), {
      type: 'ack',
      action: 'prompt',
      ok: false,
      error: 'no capacity',
    });
  });

  it('rejects malformed and unknown messages without closing the socket', async () => {
    const store = new EventStore('s1');
    const socket = fakeSocket();
    handleConnection(socket, stubSessions(store), 's1', 0);
    await settle();

    socket.deliverRaw('{not json');
    assert.deepEqual(socket.sent.at(-1), { type: 'error', message: 'Invalid JSON' });

    socket.deliver({ type: 'hello' });
    assert.deepEqual(socket.sent.at(-1), { type: 'error', message: 'Unknown message type' });
    assert.equal(socket.closed(), null);
  });

  it('a message arriving before the session is open is ignored, not rejected', async () => {
    const store = new EventStore('s1');
    const socket = fakeSocket();
    let release: (() => void) | undefined;
    handleConnection(
      socket,
      stubSessions(store, { ensureOpen: () => new Promise((r) => (release = () => r({}))) }),
      's1',
      0,
    );

    socket.deliver({ type: 'set_model', modelId: 'm1' });
    assert.deepEqual(socket.sent, [], 'nothing should be sent before replay finishes');
    release?.();
    await settle();
    assert.ok(socket.sent.some((m) => m.type === 'replay_complete'));
  });

  it('a session that will not open closes the socket with the reason', async () => {
    const store = new EventStore('s1');
    const socket = fakeSocket();
    handleConnection(
      socket,
      stubSessions(store, {
        ensureOpen: async () => {
          throw new Error('session is a ghost');
        },
      }),
      's1',
      0,
    );
    await settle();
    assert.deepEqual(socket.sent[0], { type: 'error', message: 'session is a ghost' });
    assert.equal(socket.closed()?.code, 1011);
  });

  it('closing releases the event subscription', async () => {
    const store = new EventStore('s1');
    const socket = fakeSocket();
    const sessions = stubSessions(store);
    handleConnection(socket, sessions, 's1', 0);
    await settle();
    socket.hangUp();
    assert.deepEqual(sessions.calls, ['unsubscribed']);
  });
});

// The reason uploads are keyed by chat: a new chat has no kiro session id until it sends,
// so keying them on one meant a first message could not carry a file.
// The create route copies the body field by field, so a field added to CreateSessionRequest
// and not added here is dropped silently. chatId was, and it stranded every file attached to
// a first prompt: the upload went to the chat the client minted, then the server minted a
// different one for the session, so nothing referred to that directory again.
describe('POST /api/sessions forwards the whole request', () => {
  it('passes every field through to the manager', async () => {
    let got: Record<string, unknown> | undefined;
    const app = Fastify();
    registerSessionRoutes(app, {
      createSession: async (opts: Record<string, unknown>) => {
        got = opts;
        return { summary: { sessionId: 's1' } } as unknown as SessionDetail;
      },
    } as unknown as SessionManager);
    await app.ready();

    const body = {
      cwd: '/tmp/somewhere',
      agentId: 'casper',
      modelId: 'claude-4',
      freshWorkspace: true,
      title: 'a title',
      chatId: 'c0ffee00-0000-4000-8000-000000000000',
    };
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: body });
    assert.equal(res.statusCode, 200);
    for (const [k, v] of Object.entries(body)) {
      assert.equal(got?.[k], v, `${k} did not reach the manager`);
    }
    await app.close();
  });
});

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

describe('POST /api/chats/:chatId/uploads', () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof Fastify>>;
  const origData = config.casperDataDir;

  const post = (chatId: string, filename: string, body: string) => {
    const boundary = '----casperTest';
    const payload =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
      `Content-Type: text/plain\r\n\r\n${body}\r\n--${boundary}--\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/uploads`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  before(async () => {
    dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-chat-uploads-')));
    (config as { casperDataDir: string }).casperDataDir = dataDir;
    app = Fastify();
    await app.register(multipart);
    registerUploadRoutes(app);
    await app.ready();
  });

  after(async () => {
    await app.close();
    (config as { casperDataDir: string }).casperDataDir = origData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts a file for a chat that has no session yet', async () => {
    const chatId = crypto.randomUUID();
    const res = await post(chatId, 'notes.txt', 'hello from a draft');
    assert.equal(res.statusCode, 200);
    const body = res.json() as UploadResponse;
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0]!.name, 'notes.txt');
    // Under the chat's own directory, which is the whole point.
    assert.equal(
      path.dirname(body.files[0]!.path),
      path.join(dataDir, 'chats', chatId, 'uploads'),
    );
    assert.equal(fs.readFileSync(body.files[0]!.path, 'utf8'), 'hello from a draft');
  });

  it('keeps the uploads directory private to the user', async () => {
    const chatId = crypto.randomUUID();
    await post(chatId, 'a.txt', 'x');
    const dir = path.join(dataDir, 'chats', chatId, 'uploads');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  // The id names a directory and comes from the client, so its shape is the guard.
  it('refuses an id that is not a uuid', async () => {
    for (const bad of ['not-a-uuid', 'a/../../escape', '']) {
      const res = await post(bad, 'a.txt', 'x');
      // 400 from the handler, or 404 when the router rejects the shape before it - either
      // way it does not land.
      assert.notEqual(res.statusCode, 200, bad);
    }
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'chats')).filter((d) => !isUuid(d)), []);
  });
});

// The handlers are thin over confinedFile now, so these check the wiring: that
// each route asks for the right thing and passes the status straight through.
describe('workspace file routes', () => {
  let cwd: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const buildApp = async (dir: string) => {
    const instance = Fastify();
    registerWorkspaceRoutes(instance, { getSessionCwd: async () => dir });
    await instance.ready();
    return instance;
  };

  before(async () => {
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-routes-')));
    fs.writeFileSync(path.join(cwd, 'note.md'), '# hi');
    fs.mkdirSync(path.join(cwd, 'src'));
    app = await buildApp(cwd);
  });

  after(async () => {
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const get = (route: string, p?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/sessions/s1/${route}`,
      query: p === undefined ? {} : { path: p },
    });

  it('the tree lists the workspace, directories first', async () => {
    const res = await get('tree');
    assert.equal(res.statusCode, 200);
    const body = res.json() as TreeResponse;
    assert.deepEqual(
      body.entries.map((e) => [e.name, e.type]),
      [
        ['src', 'directory'],
        ['note.md', 'file'],
      ],
    );
  });

  it('the tree refuses to walk out of the workspace', async () => {
    const res = await get('tree', '../..');
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, 'Invalid path');
  });

  it('download and preview require a path and serve the file', async () => {
    assert.equal((await get('download')).statusCode, 400);
    assert.equal((await get('preview')).statusCode, 400);

    const dl = await get('download', 'note.md');
    assert.equal(dl.statusCode, 200);
    assert.match(dl.headers['content-disposition'] as string, /attachment; filename="note.md"/);

    const pv = await get('preview', 'note.md');
    assert.equal(pv.statusCode, 200);
    assert.equal(pv.body, '# hi');
  });

  it('a directory is not downloadable, and a missing file is 404', async () => {
    assert.equal((await get('download', 'src')).statusCode, 400);
    assert.equal((await get('download', 'gone.md')).statusCode, 404);
  });

  it('a deleted workspace says so instead of returning an empty tree', async () => {
    const doomed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casper-doomed-')));
    const instance = await buildApp(doomed);
    fs.rmSync(doomed, { recursive: true, force: true });
    try {
      const res = await instance.inject({ method: 'GET', url: '/api/sessions/s1/tree' });
      assert.equal(res.statusCode, 404);
      assert.match((res.json() as { error: string }).error, /Workspace folder no longer exists/);
    } finally {
      await instance.close();
    }
  });
});
