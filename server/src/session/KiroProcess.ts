import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import split2 from 'split2';
import {
  ACP_METHODS,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type RequestPermissionParams,
  type SessionForkParams,
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
}

// Trailing stderr lines kept for the exit message.
const STDERR_KEEP = 8;

// A compaction summarises the whole conversation, which can take minutes on a long one.
const COMPACT_TIMEOUT_MS = 10 * 60_000;

/**
 * The answer to one session/request_permission. Casper runs turns unattended, as it did
 * with `--trust-all-tools` before kiro V3 dropped that flag from `acp`, so it allows the
 * call once. It never picks "always allow", which would write a rule that also applies
 * outside Casper. With no allow option it rejects the call, or failing that cancels.
 */
export function permissionOutcome(params: RequestPermissionParams | undefined): {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
} {
  const options = params?.options ?? [];
  const pick = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'reject_once');
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

// Owns one kiro-cli acp child and its ACP client, independent of any browser socket.
export class KiroProcess extends EventEmitter {
  readonly client: AcpClient;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: Logger;
  private disposed = false;
  private readonly recentStderr: string[] = [];
  // kiro's optional methods, as advertised by initialize.
  private extensionMethods = new Set<string>();
  // Whether kiro can rewind a session to before one of its prompts.
  private checkpoints = false;

  constructor(opts: KiroProcessOptions, log: Logger) {
    super();
    this.log = log;

    // The agent and model are session inputs under V3, not launch flags.
    const args = ['acp', '--agent-engine', 'v3'];

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

    // Every request from kiro gets an answer, or the turn waiting on it stalls.
    this.client.on('serverRequest', (req: JsonRpcRequest) => {
      if (req.method === ACP_METHODS.requestPermission) {
        this.client.respond(req.id, permissionOutcome(req.params as RequestPermissionParams | undefined));
        return;
      }
      this.log.debug({ method: req.method }, 'acp: unsupported request from kiro');
      this.client.respondError(req.id, -32601, `Method not found: ${req.method}`);
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

  /** The ACP initialize handshake. Keeps the optional methods kiro advertises. */
  async initialize(): Promise<void> {
    const res = await this.client.request<{
      agentCapabilities?: { _meta?: { kiro?: { extensionMethods?: unknown; checkpoints?: unknown } } };
    }>(ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'casper', version: '0.5.0' },
    });
    const methods = res?.agentCapabilities?._meta?.kiro?.extensionMethods;
    this.extensionMethods = new Set(
      Array.isArray(methods) ? methods.filter((m): m is string => typeof m === 'string') : [],
    );
    this.checkpoints = res?.agentCapabilities?._meta?.kiro?.checkpoints === true;
  }

  newSession(params: SessionNewParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionNew, params);
  }

  loadSession(params: SessionLoadParams): Promise<SessionNewResult> {
    return this.client.request<SessionNewResult>(ACP_METHODS.sessionLoad, params);
  }

  forkSession(params: SessionForkParams): Promise<{ sessionId: string }> {
    return this.client.request<{ sessionId: string }>(ACP_METHODS.sessionFork, params);
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
    return this.client.request(ACP_METHODS.sessionSetConfigOption, {
      sessionId,
      configId: 'model',
      value: modelId,
    });
  }

  setEffort(sessionId: string, effortLevel: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.sessionSetConfigOption, {
      sessionId,
      configId: 'effortLevel',
      value: effortLevel,
    });
  }

  /** Sends a message into the running turn. kiro passes it to the model at its next step,
   *  reporting that as `steering_injected`. Resolves with kiro's id for it. */
  async steer(sessionId: string, message: string, messageId: string): Promise<string | undefined> {
    const res = await this.client.request<{ queued?: boolean; messageId?: string }>(ACP_METHODS.steer, {
      sessionId,
      message,
      messageId,
    });
    if (res?.queued !== true) throw new Error('kiro did not take the message');
    return typeof res.messageId === 'string' ? res.messageId : undefined;
  }

  /** Drops the messages sent into a turn that the model has not read yet. */
  clearSteers(sessionId: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.steerClear, { sessionId });
  }

  /**
   * Rewinds the session to before the prompt `messageId`, removing it and everything after.
   * kiro also restores the files changed since, so this is only for a turn that changed
   * nothing. False when kiro cannot or did not.
   */
  async revertTo(sessionId: string, messageId: string): Promise<boolean> {
    if (!this.checkpoints) return false;
    const res = await this.client.request<{ success?: boolean }>(ACP_METHODS.checkpointRevert, { sessionId, messageId });
    return res?.success === true;
  }

  /** What the session's context holds, as kiro's `/context show` reports it. */
  async contextBreakdown(sessionId: string): Promise<Record<string, { percent?: number } | undefined> | undefined> {
    const res = await this.client.request<{ breakdown?: Record<string, { percent?: number } | undefined> } | null>(
      ACP_METHODS.sessionContext,
      { sessionId, subcommand: 'show' },
    );
    return res?.breakdown;
  }

  /** The user's plan and its use this billing cycle. Not session-scoped. */
  accountUsage(): Promise<unknown> {
    return this.client.request(ACP_METHODS.accountUsage, {});
  }

  listMemories(): Promise<unknown> {
    return this.client.request(ACP_METHODS.memoryList, {});
  }

  deleteMemory(id: string): Promise<unknown> {
    return this.client.request(ACP_METHODS.memoryDelete, { id });
  }

  /** Summarises the conversation so far. Resolves once kiro has finished. */
  compact(sessionId: string): Promise<unknown> {
    if (!this.extensionMethods.has(ACP_METHODS.compact)) {
      return Promise.reject(new Error('This kiro-cli does not offer compaction'));
    }
    return this.client.request(ACP_METHODS.compact, { sessionId }, COMPACT_TIMEOUT_MS);
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
