import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import type { SessionConfigOption, SessionPromptResult } from '@casper/shared';
import type { ManagedProcess } from '../server/src/session/SessionManager.js';

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'DocumentFragment',
];

/**
 * A jsdom window wired into globalThis for rendering React components outside a
 * browser: adds matchMedia, which jsdom has none of, and sets
 * IS_REACT_ACT_ENVIRONMENT so `act` doesn't warn. `extraGlobals` lets a test add
 * what it needs (localStorage, DataTransfer, File, ...) without copying this list.
 * tsx compiles JSX here with the classic runtime - run from the repo root it never
 * reads web/tsconfig.json - so components' JSX becomes React.createElement calls
 * with no React import in scope; this also sets globalThis.React to cover that.
 */
export async function installDomGlobals(extraGlobals: string[] = []) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://casper.test/',
  });
  const w = dom.window as unknown as Record<string, unknown>;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [...DOM_GLOBALS, ...extraGlobals]) {
    if (w[key] !== undefined) g[key] = w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const react = await import('react');
  g.React = react.default ?? react;
  const host = (w.document as Document).getElementById('host') as HTMLElement;
  return { dom, window: w, host, react };
}

/** Shared by the suites that construct server objects wanting a logger. */
export function noopLogger() {
  const log = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
    child() {
      return log;
    },
  };
  return log as unknown as import('../server/src/util/logger.js').Logger;
}

export interface FakeProcess extends ManagedProcess {
  /** Emit what kiro would have sent. */
  readonly bus: EventEmitter;
  readonly calls: string[];
  /** The arguments of each call, in the same order as `calls`. */
  readonly args: unknown[][];
  readonly disposed: () => boolean;
}

/**
 * A kiro process that spawns nothing: it answers the handshake with whatever the
 * test says and emits notifications on demand. Lets SessionManager's spawn,
 * evict, adopt and replay-gating paths be driven through its public surface
 * instead of reaching into private methods.
 */
export function fakeKiroProcess(
  opts: {
    /** The id kiro "assigns", so session-id adoption can be exercised. */
    sessionId?: string;
    currentModeId?: string;
    availableModes?: { id: string; name: string }[];
    /** The model kiro reports in its config options. */
    modelId?: string;
    /** What `_kiro/session/context` and `_kiro/account/getUsage` answer. */
    breakdown?: Record<string, { percent?: number }>;
    /** What `_session/steer` answers with: kiro's id for the message. */
    onSteer?: (sessionId: string, message: string, messageId: string) => Promise<string | undefined>;
    /** Whether `_kiro/checkpoint/revertMultiple` succeeds. */
    revert?: boolean;
    account?: unknown;
    /** The whole config options kiro reports, in place of the one built from modelId. */
    configOptions?: SessionConfigOption[];
    onPrompt?: () => Promise<SessionPromptResult>;
    onInitialize?: () => Promise<unknown>;
    /** Hold the shutdown open, so a reload can be observed mid-flight. */
    onDisposeAndWait?: () => Promise<void>;
    onCompact?: () => Promise<unknown>;
  } = {},
): FakeProcess {
  const bus = new EventEmitter();
  const calls: string[] = [];
  const args: unknown[][] = [];
  let disposed = false;
  const handshake = async () => ({
    sessionId: opts.sessionId ?? 'kiro-session',
    modes: {
      availableModes: opts.availableModes ?? [{ id: 'casper', name: 'casper' }],
      currentModeId: opts.currentModeId ?? 'casper',
    },
    ...(opts.configOptions
      ? { configOptions: opts.configOptions }
      : opts.modelId
        ? { configOptions: [{ id: 'model', currentValue: opts.modelId }] }
        : {}),
  });
  const log = (name: string, a: unknown[]) => {
    calls.push(name);
    args.push(a);
  };

  return {
    bus,
    calls,
    args,
    disposed: () => disposed,
    on(event: string, cb: (...args: never[]) => void) {
      return bus.on(event, cb as (...args: unknown[]) => void);
    },
    initialize: opts.onInitialize ?? (async () => ({})),
    async newSession(...a: unknown[]) {
      log('newSession', a);
      return handshake();
    },
    // kiro answers a load without the session's id.
    async loadSession(...a: unknown[]) {
      log('loadSession', a);
      const { sessionId: _, ...rest } = await handshake();
      return rest as Awaited<ReturnType<typeof handshake>>;
    },
    // Recorded even when a test supplies its own onPrompt, so "which process got
    // prompted" is answerable - the reload race turns on exactly that.
    async prompt(...a: unknown[]) {
      log('prompt', a);
      return opts.onPrompt
        ? opts.onPrompt()
        : ({ stopReason: 'end_turn' } as SessionPromptResult);
    },
    stderrTail: () => '',
    cancel(...a: unknown[]) {
      log('cancel', a);
    },
    answerElicitation(...a: unknown[]) {
      log('answerElicitation', a);
    },
    async setMode(...a: unknown[]) {
      log('setMode', a);
    },
    async setModel(...a: unknown[]) {
      log('setModel', a);
    },
    async setEffort(...a: unknown[]) {
      log('setEffort', a);
    },
    async contextBreakdown(...a: unknown[]) {
      log('contextBreakdown', a);
      return opts.breakdown;
    },
    async accountUsage(...a: unknown[]) {
      log('accountUsage', a);
      return opts.account;
    },
    async steer(...a: unknown[]) {
      log('steer', a);
      return opts.onSteer ? opts.onSteer(...(a as [string, string, string])) : `steer-${String(a[2])}`;
    },
    async clearSteers(...a: unknown[]) {
      log('clearSteers', a);
    },
    async revertTo(...a: unknown[]) {
      log('revertTo', a);
      return opts.revert ?? true;
    },
    async forkSession(...a: unknown[]) {
      log('forkSession', a);
      return { sessionId: (await handshake()).sessionId };
    },
    async compact(...a: unknown[]) {
      log('compact', a);
      if (opts.onCompact) return opts.onCompact();
    },
    dispose() {
      disposed = true;
      log('dispose', []);
    },
    async disposeAndWait() {
      disposed = true;
      // Recorded before the hook runs, so a test can see the reload has reached
      // shutdown while the hook still holds it there.
      log('disposeAndWait', []);
      if (opts.onDisposeAndWait) await opts.onDisposeAndWait();
    },
  } as FakeProcess;
}

/** Polls to a deadline instead of sleeping a fixed time. */
export async function waitFor(what: string, ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** One line of a kiro V3 conversation file. */
export interface V3Line {
  id: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

/**
 * Writes a session the way kiro V3 stores it, <sessions>/<workspace hash>/<id>/, and
 * returns that directory. The shapes follow what kiro-cli 3.1 wrote.
 */
export function writeV3Session(
  sessionsDir: string,
  s: {
    id: string;
    cwd: string;
    title?: string;
    agentMode?: string;
    modelId?: string;
    createdAt?: string;
    lastModifiedAt?: string;
    messages?: V3Line[];
    subExecutions?: Record<string, V3Line[]>;
  },
): string {
  const workspace = crypto.createHash('sha256').update(s.cwd).digest('hex').slice(0, 16);
  const dir = path.join(sessionsDir, workspace, s.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0.0',
        id: s.id,
        title: s.title ?? 'New Session',
        agentMode: s.agentMode ?? 'vibe',
        workspacePaths: [s.cwd],
        createdAt: s.createdAt ?? '2026-11-07T06:39:07.031Z',
        lastModifiedAt: s.lastModifiedAt ?? '2026-11-07T06:39:15.621Z',
        ...(s.modelId ? { modelId: s.modelId } : {}),
      },
      null,
      2,
    ),
  );
  const lines = (ls: V3Line[]) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (s.messages) fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines(s.messages));
  for (const [subId, ls] of Object.entries(s.subExecutions ?? {})) {
    fs.mkdirSync(path.join(dir, 'sub-executions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub-executions', `${subId}.jsonl`), lines(ls));
  }
  return dir;
}
