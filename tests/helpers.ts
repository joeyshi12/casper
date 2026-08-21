import { EventEmitter } from 'node:events';
import type { SessionPromptResult } from '@casper/shared';
import type { ManagedProcess } from '../server/src/session/SessionManager.js';

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
    onPrompt?: () => Promise<SessionPromptResult>;
    onInitialize?: () => Promise<unknown>;
    /** Hold the shutdown open, so a reload can be observed mid-flight. */
    onDisposeAndWait?: () => Promise<void>;
  } = {},
): FakeProcess {
  const bus = new EventEmitter();
  const calls: string[] = [];
  let disposed = false;
  const handshake = async () => ({
    sessionId: opts.sessionId ?? 'kiro-session',
    modes: {
      availableModes: [{ id: 'casper', name: 'casper' }],
      currentModeId: opts.currentModeId ?? 'casper',
    },
  });

  return {
    bus,
    calls,
    disposed: () => disposed,
    on(event: string, cb: (...args: never[]) => void) {
      return bus.on(event, cb as (...args: unknown[]) => void);
    },
    initialize: opts.onInitialize ?? (async () => ({})),
    async newSession() {
      calls.push('newSession');
      return handshake();
    },
    async loadSession() {
      calls.push('loadSession');
      return handshake();
    },
    // Recorded even when a test supplies its own onPrompt, so "which process got
    // prompted" is answerable - the reload race turns on exactly that.
    async prompt() {
      calls.push('prompt');
      return opts.onPrompt
        ? opts.onPrompt()
        : ({ stopReason: 'end_turn' } as SessionPromptResult);
    },
    stderrTail: () => '',
    cancel() {
      calls.push('cancel');
    },
    async setMode() {
      calls.push('setMode');
    },
    async setModel() {
      calls.push('setModel');
    },
    async execCommand() {
      calls.push('execCommand');
    },
    dispose() {
      disposed = true;
      calls.push('dispose');
    },
    async disposeAndWait() {
      disposed = true;
      // Recorded before the hook runs, so a test can see the reload has reached
      // shutdown while the hook still holds it there.
      calls.push('disposeAndWait');
      if (opts.onDisposeAndWait) await opts.onDisposeAndWait();
    },
  } as FakeProcess;
}
