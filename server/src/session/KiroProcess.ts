import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import split2 from 'split2';
import {
  ACP_METHODS,
  type JsonRpcNotification,
  type SessionLoadParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
} from '@casper/shared';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { AcpClient } from '../acp/AcpClient.js';

interface KiroProcessOptions {
  cwd: string;
  agent?: string;
  model?: string;
}

// How many trailing stderr lines to keep for the exit message. Enough to carry
// a login/auth error without letting a chatty process grow this unbounded.
const STDERR_KEEP = 8;

// Owns one kiro-cli acp child process and its ACP client. Its lifecycle is
// independent of any browser socket: it lives until disposed or it exits.
export class KiroProcess extends EventEmitter {
  readonly client: AcpClient;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: Logger;
  private disposed = false;
  private readonly recentStderr: string[] = [];

  constructor(opts: KiroProcessOptions, log: Logger) {
    super();
    this.log = log;

    const args = ['acp', '--trust-all-tools'];
    if (opts.agent) args.push('--agent', opts.agent);
    if (opts.model) args.push('--model', opts.model);

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

    // Keep the tail of stderr, not just the log: when kiro dies (expired
    // credentials, a bad flag) the reason is printed here, and 'process exited
    // (code=1)' on its own tells the user nothing.
    const stderrLines = this.child.stderr.pipe(split2());
    stderrLines.on('data', (line: string) => {
      if (!line.trim()) return;
      this.log.debug({ stderr: line }, 'kiro-cli stderr');
      this.recentStderr.push(line.trim());
      if (this.recentStderr.length > STDERR_KEEP) this.recentStderr.shift();
    });
    // 'exit' can arrive before the last of stderr has been read, and on some node
    // versions it does: the reason came out as a bare "exited with code 1" with kiro's
    // actual complaint still in the pipe. Wait for the stream to finish instead of
    // depending on which callback the event loop runs first.
    const stderrEnded = new Promise<void>((resolve) => {
      stderrLines.once('end', resolve);
      stderrLines.once('error', () => resolve());
    });

    this.child.on('exit', (code, signal) => {
      // Bounded: a stream that somehow never ends must not wedge the exit path, or an
      // in-flight request would never reject and the session would never go dormant.
      const capped = new Promise<void>((resolve) => setTimeout(resolve, 250).unref());
      void Promise.race([stderrEnded, capped]).then(() => {
        this.client.fail(this.exitReason(code, signal));
        if (!this.disposed) {
          this.log.warn({ code, signal }, 'kiro-cli acp exited unexpectedly');
        }
        this.emit('exit', code, signal);
      });
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

  /** Perform the ACP initialize handshake. kiro's reply is not used. */
  async initialize(): Promise<void> {
    await this.client.request(ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      // Informational only - kiro logs it and nothing reads it back, so it isn't
      // worth wiring to package.json.
      clientInfo: { name: 'casper', version: '0.5.0' },
    });
  }

  newSession(params: SessionNewParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionNew, params);
  }

  loadSession(params: SessionLoadParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionLoad, params);
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
    // kiro expects a structured command: { command: <name>, args: <object> }.
    // The name has no leading slash (advertised as "/compact", executed as
    // "compact"). A flat string param crashes the agent.
    return this.client.request(ACP_METHODS.commandsExecute, {
      sessionId,
      command: { command: command.replace(/^\//, ''), args: args ? { input: args } : {} },
    });
  }

  /** Cleanly shut down: close stdin (triggers kiro's graceful exit), then kill. */
  /**
   * Recent stderr from kiro, for attaching to a failure.
   *
   * A failed request doesn't always carry its cause in the JSON-RPC error - when
   * it doesn't, kiro has usually written something here. Shared across turns, so
   * treat it as context rather than proof.
   */
  stderrTail(): string {
    return this.recentStderr.join('\n').trim();
  }

  /**
   * Why the child died, in terms a user can act on. The exit code alone is
   * opaque, so append what kiro printed - that's where "credentials have
   * expired, run kiro-cli login" and friends show up.
   */
  private exitReason(code: number | null, signal: string | null): string {
    const base =
      signal ? `kiro-cli exited on ${signal}` : `kiro-cli exited with code ${code}`;
    const tail = this.recentStderr.join('\n').trim();
    return tail ? `${base}: ${tail}` : base;
  }

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
