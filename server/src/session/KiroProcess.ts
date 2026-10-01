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

// Trailing stderr lines kept for the exit message.
const STDERR_KEEP = 8;

// Owns one kiro-cli acp child and its ACP client, independent of any browser socket.
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

    // Answer agent-initiated requests minimally so the turn never stalls. With
    // --trust-all-tools kiro shouldn't ask for permission, but fs/terminal client
    // requests can still arrive.
    this.client.on('serverRequest', (req) => {
      this.log.debug({ method: req.method }, 'acp: unhandled server request');
      this.client.respond(req.id, {});
    });

    // Keep the tail of stderr: when kiro dies the reason is printed here.
    const stderrLines = this.child.stderr.pipe(split2());
    stderrLines.on('data', (line: string) => {
      if (!line.trim()) return;
      this.log.debug({ stderr: line }, 'kiro-cli stderr');
      this.recentStderr.push(line.trim());
      if (this.recentStderr.length > STDERR_KEEP) this.recentStderr.shift();
    });
    // 'exit' can arrive before stderr finishes reading.
    const stderrEnded = new Promise<void>((resolve) => {
      stderrLines.once('end', resolve);
      stderrLines.once('error', () => resolve());
    });

    this.child.on('exit', (code, signal) => {
      // Bounded so a stream that never ends can't wedge the exit path.
      const capped = new Promise<void>((resolve) => setTimeout(resolve, 250).unref());
      void Promise.race([stderrEnded, capped]).then(() => {
        this.client.fail(this.exitReason(code, signal));
        if (!this.disposed) {
          this.log.warn({ code, signal }, 'kiro-cli acp exited unexpectedly');
        }
        this.emit('exit', code, signal);
      });
    });

    // Not re-emitted: an EventEmitter with no 'error' listener throws.
    this.child.on('error', (err) => {
      this.log.error({ err }, 'kiro-cli acp spawn error');
      this.client.fail(err.message);
    });

    this.child.stdin.on('error', () => {});
    this.child.stdout.on('error', () => {});
  }

  /** The ACP initialize handshake. kiro's reply is not used. */
  async initialize(): Promise<void> {
    await this.client.request(ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'casper', version: '0.5.0' },
    });
  }

  newSession(params: SessionNewParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionNew, params);
  }

  loadSession(params: SessionLoadParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionLoad, params);
  }

  /** Runs a prompt turn to completion. */
  prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    // Disable the timeout: a long agent task can run for many minutes.
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

  execCommand(sessionId: string, command: string): Promise<unknown> {
    // kiro expects { command: <name>, args }, no leading slash on the name.
    return this.client.request(ACP_METHODS.commandsExecute, {
      sessionId,
      command: { command: command.replace(/^\//, ''), args: {} },
    });
  }

  /** Recent stderr from kiro, for attaching to a failure. */
  stderrTail(): string {
    return this.recentStderr.join('\n').trim();
  }

  /** Why the child died: exit code plus whatever kiro printed. */
  private exitReason(code: number | null, signal: string | null): string {
    const base =
      signal ? `kiro-cli exited on ${signal}` : `kiro-cli exited with code ${code}`;
    const tail = this.recentStderr.join('\n').trim();
    return tail ? `${base}: ${tail}` : base;
  }

  // Closes stdin to trigger kiro's graceful exit, then force-kills if it lingers.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill('SIGTERM');
    }, 1000).unref();
  }

  /** Resolves once the child has exited. Caller must wait before deleting
   *  session files, or kiro's shutdown write recreates them. */
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
