import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import split2 from 'split2';
import {
  ACP_METHODS,
  type InitializeResult,
  type JsonRpcNotification,
  type SessionLoadParams,
  type SessionLoadResult,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
} from '@casper/shared';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { AcpClient } from '../acp/AcpClient.js';

export interface KiroProcessOptions {
  cwd: string;
  agent?: string;
  model?: string;
  effort?: string;
}

// Owns one kiro-cli acp child process and its ACP client. Its lifecycle is
// independent of any browser socket: it lives until disposed or it exits.
export class KiroProcess extends EventEmitter {
  readonly client: AcpClient;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: Logger;
  private disposed = false;
  private initialized = false;

  constructor(opts: KiroProcessOptions, log: Logger) {
    super();
    this.log = log;

    const args = ['acp', '--trust-all-tools'];
    if (opts.agent) args.push('--agent', opts.agent);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);

    this.log.info({ bin: config.kiroBin, args, cwd: opts.cwd }, 'spawning kiro-cli acp');
    this.child = spawn(config.kiroBin, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    }) as ChildProcessWithoutNullStreams;

    this.client = new AcpClient(this.child.stdout, this.child.stdin, log);

    this.client.on('notification', (n: JsonRpcNotification) => {
      this.emit('notification', n);
    });

    // Answer agent-initiated requests minimally so the turn never stalls.
    // With --trust-all-tools kiro shouldn't ask for permission, but fs/terminal
    // client requests can still arrive; reject unknown ones politely.
    this.client.on('serverRequest', (req) => {
      this.log.debug({ method: req.method }, 'acp: unhandled server request');
      this.client.respond(req.id, {});
    });

    // Surface stderr lines to the logger (kiro logs errors here).
    this.child.stderr.pipe(split2()).on('data', (line: string) => {
      if (line.trim()) this.log.debug({ stderr: line }, 'kiro-cli stderr');
    });

    this.child.on('exit', (code, signal) => {
      this.client.fail(`process exited (code=${code}, signal=${signal})`);
      if (!this.disposed) {
        this.log.warn({ code, signal }, 'kiro-cli acp exited unexpectedly');
      }
      this.emit('exit', code, signal);
    });

    // A spawn failure (e.g. bad cwd or missing binary) emits 'error'. Fail the
    // ACP client so any in-flight request (like initialize) rejects, then log
    // it. We do NOT re-emit 'error': an EventEmitter with no 'error' listener
    // throws and would crash the server.
    this.child.on('error', (err) => {
      this.log.error({ err }, 'kiro-cli acp spawn error');
      this.client.fail(err.message);
    });

    // Swallow stdin errors (e.g. EPIPE when writing to a process that failed to
    // spawn) so they don't surface as unhandled stream errors.
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('error', () => {});
  }

  /** Perform the ACP initialize handshake. Idempotent. */
  async initialize(): Promise<InitializeResult> {
    const result = await this.client.request<InitializeResult>(ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'casper', version: '0.1.0' },
    });
    this.initialized = true;
    return result;
  }

  newSession(params: SessionNewParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionNew, params);
  }

  loadSession(params: SessionLoadParams): Promise<SessionLoadResult> {
    return this.client.request<SessionLoadResult>(ACP_METHODS.sessionLoad, params);
  }

  /** Run a prompt turn to completion. Resolves with the stop reason. */
  prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    // A long agent task can run for many minutes; disable the request timeout.
    return this.client.request<SessionPromptResult>(
      ACP_METHODS.sessionPrompt,
      params,
      0,
    );
  }

  cancel(sessionId: string): void {
    this.client.notify(ACP_METHODS.sessionCancel, { sessionId });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.sessionSetMode, { sessionId, modeId });
  }

  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.sessionSetModel, { sessionId, modelId });
  }

  execCommand(sessionId: string, command: string, args?: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.commandsExecute, {
      sessionId,
      command,
      args,
    });
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Cleanly shut down: close stdin (triggers kiro's graceful exit), then kill. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    // Give kiro a moment to flush, then force-kill if still alive.
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill('SIGTERM');
    }, 1000).unref();
  }

  /**
   * Dispose and resolve once the child has actually exited. kiro writes its
   * session file on shutdown, so a caller that then deletes those files must
   * wait for exit first, or kiro's write recreates them.
   */
  disposeAndWait(timeoutMs = 4000): Promise<void> {
    if (this.child.exitCode !== null) {
      this.dispose();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.child.once('exit', finish);
      this.dispose();
      setTimeout(finish, timeoutMs).unref();
    });
  }
}
