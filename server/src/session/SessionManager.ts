import {
  ACP_METHODS,
  emptyObservabilitySnapshot,
  KIRO_AGENT_NOT_FOUND,
  stripAttachmentsLine,
  type AgentMode,
  type CasperEvent,
  type CasperEventPayload,
  type KiroUpdateMeta,
  type MessageAttachment,
  type JsonRpcNotification,
  type PromptContentBlock,
  type ChatDetail,
  type SessionLoadParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type ChatSummary,
  type SessionInfoUpdate,
  type SessionUpdate,
  type SessionUpdateParams,
  type SubagentDetailResponse,
  type SubagentSummary,
  type TranscriptItem,
  type TurnEnding,
  resolveSessionTitle,
  sanitizeTitle,
  titleFromPrompt,
} from '@casper/shared';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { invalidateAgents, rememberModes } from './agents.js';
import { createChatWorkspace, isManagedWorkspace, removeChatDir } from './chats.js';
import type { Logger } from '../util/logger.js';
import { isWithinRoot, isValidChatId } from '../util/paths.js';
import { KiroProcess } from './KiroProcess.js';
import { EventStore } from './EventStore.js';
import { TurnState } from './TurnState.js';
import { TurnRecorder } from './TurnRecorder.js';
import { SubagentTracker } from './SubagentTracker.js';
import { showSummaryAsAnswer } from './subagentResult.js';
import { matchSubagentsFallback, subagentCallsIn } from './subagentFallbackMatch.js';
import {
  deletePersistedSession,
  hydrateSubExecution,
  hydrateTranscript,
  isLoadable,
  listChildSessions,
  listSubExecutions,
  readChildSession,
  promptCount,
  readPersistedSession,
  readPersistedSessions,
  type PersistedSession,
  type SubExecution,
} from './kiroFiles.js';
import { ChatStore, type ChatRow } from './chatStore.js';
import { SubagentLinkStore } from './subagentLinks.js';

// Resolves a cwd to an absolute path, creating it if missing. Confined to
// config.fileRoot, which the file endpoints are also scoped to.
function resolveCwd(input?: string): string {
  const raw = input?.trim();
  const abs = raw ? path.resolve(config.defaultCwd, raw) : config.defaultCwd;

  if (!isWithinRoot(config.fileRoot, abs)) {
    throw new Error(`Working directory is outside the allowed root: ${abs}`);
  }

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = undefined;
  }
  if (stat && !stat.isDirectory()) {
    throw new Error(`Working directory path is a file, not a directory: ${abs}`);
  }
  if (!stat) {
    fs.mkdirSync(abs, { recursive: true });
  }
  return abs;
}

// Lets eviction, capacity and session-id adoption be tested without spawning anything.
export interface ManagedProcess {
  on(event: 'notification', cb: (n: JsonRpcNotification) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  initialize(): Promise<unknown>;
  newSession(params: SessionNewParams): Promise<SessionNewResult>;
  loadSession(params: SessionLoadParams): Promise<SessionNewResult>;
  prompt(params: SessionPromptParams): Promise<SessionPromptResult>;
  stderrTail(): string;
  cancel(sessionId: string): void;
  setMode(sessionId: string, modeId: string): Promise<unknown>;
  setModel(sessionId: string, modelId: string): Promise<unknown>;
  compact(sessionId: string): Promise<unknown>;
  dispose(): void;
  disposeAndWait(timeoutMs?: number): Promise<void>;
}

export type SpawnProcess = (opts: { cwd: string }, log: Logger) => ManagedProcess;

export interface SessionManagerOptions {
  spawn?: SpawnProcess;
  /** How long a cancelled turn may take to end before its kiro process is killed. */
  cancelGraceMs?: number;
  /** The model a new chat gets when none was picked. None by default, which leaves
   *  the choice to kiro. */
  defaultModel?: () => Promise<string | undefined>;
}

const CANCEL_GRACE_MS = 10_000;

// Store, turn state and metadata exist as soon as a session is opened; the
// kiro-cli child (`proc`) spawns lazily on first action.
export class Session {
  readonly sessionId: string;
  readonly store: EventStore;
  readonly turnState = new TurnState();
  readonly recorder = new TurnRecorder();
  readonly subagents = new SubagentTracker();
  cwd: string;
  agentId?: string;
  modelId?: string;
  currentModeId?: string;
  availableModes: AgentMode[] = [];
  title = '';
  createdAt = new Date().toISOString();
  updatedAt = new Date().toISOString();
  lastActivity = Date.now();
  running = false;
  cancelRequested = false;
  // Set while a cancelled turn is given time to end before its process is killed.
  cancelTimer?: NodeJS.Timeout;
  private everLive = false;

  proc?: ManagedProcess;
  spawning?: Promise<ManagedProcess>;
  // An action during a reload waits on this instead of acting on the process
  // about to be disposed.
  reloading?: Promise<void>;
  // True while kiro replays history during session/load.
  replaying = false;

  constructor(sessionId: string, store: EventStore, cwd: string) {
    this.sessionId = sessionId;
    this.store = store;
    this.cwd = cwd;
  }

  markLive(): void {
    this.everLive = true;
  }
  get hasBeenLive(): boolean {
    return this.everLive;
  }

  // Folds the event into the live snapshot and persists it in one call.
  record(payload: CasperEventPayload): CasperEvent {
    this.updatedAt = new Date().toISOString();
    this.turnState.apply(payload);
    const event = this.store.append(payload);
    this.recorder.observe(event);
    return event;
  }
}

// The session updates the transcript is built from. kiro sends others, such as its
// command list and settings, which nothing here reads.
const TRANSCRIPT_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);

function kiroMeta(update: SessionUpdate): KiroUpdateMeta | undefined {
  return (update as { _meta?: { kiro?: KiroUpdateMeta } })._meta?.kiro;
}

/** The event Casper records for one of kiro's session-level updates, if any. */
function sessionInfoEvent(sessionId: string, update: SessionInfoUpdate): CasperEventPayload | null {
  const info = update._meta?.kiro;
  switch (info?.kind) {
    case 'context_usage':
      return typeof info.usagePercentage === 'number'
        ? { kind: 'metadata', params: { sessionId, contextUsagePercentage: info.usagePercentage } }
        : null;
    case 'summarization_started':
      return { kind: 'compaction', params: { sessionId, status: { type: 'started' }, summary: null } };
    case 'summarization_completed':
      return {
        kind: 'compaction',
        params: { sessionId, status: { type: 'completed' }, summary: info.conversationSummary ?? null },
      };
    case 'summarization_failed':
      return { kind: 'compaction', params: { sessionId, status: { type: 'failed' }, summary: null } };
    default:
      return null;
  }
}

/** The model kiro reports a session is using. */
function sessionModel(res: SessionNewResult): string | undefined {
  return res.configOptions?.find((o) => o.id === 'model')?.currentValue;
}

/** The row for a subagent read back from its parent's file. */
function subExecutionSummary(sub: SubExecution): SubagentSummary {
  return {
    sessionId: sub.sessionId,
    stageName: sub.name,
    toolCallId: sub.toolCallId,
    status: sub.status,
    activity: sub.stopped ? 'Stopped' : undefined,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

// Transcript items per page; a full transcript can be multiple MB.
const TRANSCRIPT_PAGE_SIZE = 80;

function newerOf(a: string | undefined, b: string): string {
  return a && a.localeCompare(b) > 0 ? a : b;
}

function firstPromptText(transcript: TranscriptItem[]): string | undefined {
  const first = transcript.find((it) => it.type === 'message' && it.message.role === 'user');
  return first?.type === 'message' ? first.message.text : undefined;
}

// A session once live with no file and no process was deleted externally.
function isGhost(s: Session, hasFile: boolean): boolean {
  return !hasFile && s.hasBeenLive && !s.proc;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly store = new ChatStore();
  private readonly subagentLinks = new SubagentLinkStore();
  // Children the title fallback already tried and could not match. Matching hydrates the
  // whole parent transcript (145 MB in one chat), so each child is tried once per process.
  private readonly unmatchedChildren = new Map<string, Set<string>>();
  private readonly spawnProcess: SpawnProcess;
  private readonly cancelGraceMs: number;
  private readonly defaultModel: () => Promise<string | undefined>;

  constructor(log: Logger, opts: SessionManagerOptions = {}) {
    this.log = log;
    this.spawnProcess = opts.spawn ?? ((o, l) => new KiroProcess(o, l));
    this.cancelGraceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.defaultModel = opts.defaultModel ?? (async () => undefined);
  }

  /** What a session is called, from every read path. */
  private titleOf(
    chat: ChatRow,
    parts: { kiroTitle?: string; firstPrompt?: string; cwd: string },
  ): string {
    return resolveSessionTitle({
      override: chat.title ?? undefined,
      kiroTitle: parts.kiroTitle,
      firstPrompt: parts.firstPrompt,
      folder: isManagedWorkspace(parts.cwd) ? undefined : path.basename(parts.cwd),
    });
  }

  renameChat(chatId: string, title: string): void {
    const clean = sanitizeTitle(title);
    this.store.setTitle(chatId, clean);
    const s = this.sessions.get(this.store.sessionIdForChat(chatId) ?? '');
    if (s) s.title = clean || s.title;
  }

  // A live process was spawned with the old cwd, so it's disposed and the next
  // turn respawns.
  async setChatCwd(chatId: string, input: string): Promise<string> {
    const resolved = resolveCwd(input);

    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);

    // Refused for the same reasons as a reload.
    if (s.running) {
      throw new Error('Cannot change the working directory while a turn is running');
    }
    if (s.turnState.get().compacting) {
      throw new Error(
        'Cannot change the working directory while the conversation is being compacted',
      );
    }

    this.store.setCwd(chatId, resolved);
    if (s.cwd !== resolved) {
      s.cwd = resolved;
      s.proc?.dispose();
      s.proc = undefined;
      this.log.info({ chatId, cwd: resolved }, 'chat working directory changed');
    }
    return resolved;
  }

  /** Restarts the session's kiro child so startup-only state (agent definition,
   *  workspace `.kiro`, MCP servers) is read again. */
  async reloadChat(chatId: string): Promise<ChatDetail> {
    const s = await this.ensureOpen(chatId);
    if (s.running) {
      throw new Error('Cannot reload while a turn is running');
    }
    // Compaction isn't a turn.
    if (s.turnState.get().compacting) {
      throw new Error('Cannot reload while the conversation is being compacted');
    }
    if (s.reloading) {
      throw new Error('A reload is already running for this session');
    }
    let ready!: () => void;
    s.reloading = new Promise<void>((resolve) => {
      ready = resolve;
    });

    try {
      return await this.replaceProcess(chatId, s);
    } finally {
      s.reloading = undefined;
      ready();
    }
  }

  /** The reload itself, called with the session's reload claim held. */
  private async replaceProcess(chatId: string, s: Session): Promise<ChatDetail> {
    // Loading an id kiro has not saved would start an empty session in its place.
    if (!(await isLoadable(s.sessionId))) {
      throw new Error(
        'kiro has not saved this session yet. Send a message first, then reload.',
      );
    }
    if (s.spawning) await s.spawning.catch(() => {});

    const old = s.proc;
    if (old) {
      // Cleared first so the exit handler doesn't record process_exited for a
      // deliberate restart.
      s.proc = undefined;
      await old.disposeAndWait().catch(() => {});
    }
    s.availableModes = [];
    invalidateAgents();
    await this.ensureProc(s);
    s.lastActivity = Date.now();
    this.log.info({ sessionId: s.sessionId, cwd: s.cwd }, 'session reloaded');
    return this.getDetail(chatId);
  }

  private async settleReload(s: Session): Promise<void> {
    if (s.reloading) await s.reloading;
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.proc) n++;
    return n;
  }

  onEvent(chatId: string, cb: (e: CasperEvent) => void): (() => void) | null {
    const s = this.sessions.get(this.store.sessionIdForChat(chatId) ?? '');
    if (!s) return null;
    s.store.on('event', cb);
    return () => s.store.off('event', cb);
  }

  getStore(chatId: string): EventStore | undefined {
    return this.sessions.get(this.store.sessionIdForChat(chatId) ?? '')?.store;
  }

  /** A chat's working directory, opened in memory if needed. */
  async getChatCwd(chatId: string): Promise<string> {
    const s = await this.ensureOpen(chatId);
    return s.cwd;
  }

  /** Opens a chat's session in memory without spawning a process. */
  async ensureOpen(chatId: string): Promise<Session> {
    const sessionId = this.sessionIdOf(chatId);
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const persisted = await readPersistedSession(sessionId, { contextUsage: true });
    if (!persisted) throw new Error(`Unknown session: ${sessionId}`);

    const effectiveCwd = this.store.getCwd(chatId) ?? persisted.cwd;

    // A pre-boundary session could carry an out-of-root cwd. Fail closed.
    if (!isWithinRoot(config.fileRoot, effectiveCwd)) {
      throw new Error(
        `Session working directory is outside the allowed root: ${effectiveCwd}`,
      );
    }

    const store = new EventStore(chatId);
    const s = new Session(sessionId, store, effectiveCwd);
    s.title = persisted.title;
    s.agentId = persisted.agentId;
    s.currentModeId = persisted.agentId;
    s.modelId = persisted.modelId;
    s.createdAt = persisted.createdAt;
    s.updatedAt = persisted.updatedAt;
    s.markLive();
    s.turnState.seed(persisted.contextUsagePercentage ?? 0);
    this.sessions.set(sessionId, s);
    return s;
  }

  private wire(s: Session, proc: ManagedProcess): void {
    proc.on('notification', (n: JsonRpcNotification) => {
      if (s.replaying) return;
      if (n.method === KIRO_AGENT_NOT_FOUND) {
        this.log.warn({ sessionId: s.sessionId, detail: n.params }, 'kiro could not use the requested agent');
        return;
      }
      if (n.method !== ACP_METHODS.sessionUpdate) return;
      const params = n.params as SessionUpdateParams | undefined;
      if (!params?.update || (params.sessionId && params.sessionId !== s.sessionId)) return;
      const { update } = params;
      const meta = kiroMeta(update);
      if (meta?.replay) return;

      if (update.sessionUpdate === 'session_info_update') {
        const payload = sessionInfoEvent(s.sessionId, update as SessionInfoUpdate);
        if (payload) s.record(payload);
        return;
      }
      if (!TRANSCRIPT_UPDATES.has(update.sessionUpdate)) return;

      const subagentId = meta?.agentSubtaskId;
      if (subagentId && meta.kind !== 'agent-subtask') {
        // A subagent's own update: it shows on the subagent's row, not in the chat.
        const title = update.sessionUpdate === 'tool_call' ? (update as { title?: string }).title : undefined;
        if (s.subagents.progressed(subagentId, title)) this.recordSubagents(s);
        return;
      }
      if (subagentId) this.trackSubagentCall(s, subagentId, update);
      s.record({ kind: 'session_update', update });
    });
    proc.on('exit', (code: number | null, signal: string | null) => {
      if (s.proc !== proc) return;
      s.record({ kind: 'process_exited', code, signal });
      s.proc = undefined;
      s.running = false;
    });
  }

  /** Follows the tool call that starts a subagent, from its start to its result. */
  private trackSubagentCall(s: Session, subagentId: string, update: SessionUpdate): void {
    const call = update as { sessionUpdate: string; toolCallId?: string; title?: string; status?: string; rawInput?: { name?: unknown } };
    if (typeof call.toolCallId !== 'string') return;
    let changed = false;
    if (call.sessionUpdate === 'tool_call') {
      const name = typeof call.rawInput?.name === 'string' ? call.rawInput.name : (call.title ?? subagentId);
      changed = s.subagents.started(subagentId, call.toolCallId, name);
    } else if (call.status === 'completed' || call.status === 'failed') {
      changed = s.subagents.finished(call.toolCallId, call.status === 'completed');
    }
    if (changed) this.recordSubagents(s);
  }

  private recordSubagents(s: Session): void {
    s.record({ kind: 'subagents_changed', subagents: s.subagents.list() });
  }

  /** Gets or spawns the kiro process for a session. */
  private async ensureProc(s: Session): Promise<ManagedProcess> {
    if (s.proc) return s.proc;
    if (s.spawning) return s.spawning;

    s.spawning = (async () => {
      await this.ensureCapacity();
      const proc = this.spawnProcess({ cwd: s.cwd }, this.log);
      this.wire(s, proc);
      await proc.initialize();

      // session/load replays the conversation as notifications; gated out while it runs.
      let res: SessionNewResult;
      if (s.hasBeenLive) {
        s.replaying = true;
        try {
          res = await proc.loadSession({
            sessionId: s.sessionId,
            cwd: s.cwd,
            mcpServers: [],
            ...(s.modelId ? { _meta: { kiro: { modelId: s.modelId } } } : {}),
          });
        } finally {
          s.replaying = false;
        }
      } else {
        res = await proc.newSession({
          cwd: s.cwd,
          mcpServers: [],
          _meta: { kiro: { modeId: s.agentId, modelId: s.modelId } },
        });
      }

      // A brand-new session adopts kiro's generated id.
      if (!s.hasBeenLive && res.sessionId !== s.sessionId) {
        this.sessions.delete(s.sessionId);
        (s as { sessionId: string }).sessionId = res.sessionId;
        this.sessions.set(res.sessionId, s);
      }
      await this.restoreMode(s, proc, res);
      s.availableModes = res.modes.availableModes;
      s.currentModeId = res.modes.currentModeId;
      s.agentId = res.modes.currentModeId ?? s.agentId;
      s.modelId = sessionModel(res) ?? s.modelId;
      rememberModes(res.modes.availableModes);
      s.markLive();
      s.proc = proc;
      s.spawning = undefined;
      return proc;
    })();

    try {
      return await s.spawning;
    } catch (err) {
      s.spawning = undefined;
      throw err;
    }
  }

  /**
   * Puts a loaded session back in the chat's agent. kiro keeps the mode a session was
   * saved with, but gives a session it copied in from kiro 2.x its Default mode, so a
   * chat that ran the casper agent would lose it.
   */
  private async restoreMode(s: Session, proc: ManagedProcess, res: SessionNewResult): Promise<void> {
    const want = s.agentId;
    if (!s.hasBeenLive || !want || res.modes.currentModeId === want) return;
    if (!res.modes.availableModes.some((m) => m.id === want)) return;
    try {
      await proc.setMode(s.sessionId, want);
      res.modes.currentModeId = want;
    } catch (err) {
      this.log.warn({ err, sessionId: s.sessionId, modeId: want }, 'could not restore the chat agent');
    }
  }

  private async ensureCapacity(): Promise<void> {
    const liveIds = [...this.sessions.values()].filter((s) => s.proc);
    if (liveIds.length < config.maxLiveSessions) return;
    let victim: Session | null = null;
    let oldest = Infinity;
    for (const s of liveIds) {
      if (!s.running && s.lastActivity < oldest) {
        oldest = s.lastActivity;
        victim = s;
      }
    }
    if (victim) {
      this.log.info({ sessionId: victim.sessionId }, 'idle process evicted for capacity');
      victim.proc?.dispose();
      victim.proc = undefined;
    } else {
      this.log.warn('at capacity but all processes are busy');
    }
  }

  /** Creates a new session. Spawns immediately to get a real kiro sessionId. */
  async createChat(opts: {
    cwd?: string;
    agentId?: string;
    modelId?: string;
    freshWorkspace?: boolean;
    title?: string;
    chatId?: string;
  }): Promise<ChatDetail> {
    const chatId = isValidChatId(opts.chatId) ? opts.chatId : crypto.randomUUID();
    const cwd = opts.freshWorkspace ? createChatWorkspace(chatId) : resolveCwd(opts.cwd);
    // Temporary local id until kiro assigns the real one during ensureProc.
    const tempId = `pending-${Date.now()}-${Math.floor(this.sessions.size)}`;
    const store = new EventStore(chatId);
    const s = new Session(tempId, store, cwd);
    s.agentId = opts.agentId ?? config.defaultAgent;
    s.currentModeId = s.agentId;
    s.modelId = opts.modelId ?? (await this.defaultModel());
    this.sessions.set(tempId, s);

    try {
      await this.ensureProc(s); // adopts kiro's real sessionId
    } catch (err) {
      // Drop the orphan so it can't leak or show up as a dead, unopenable row.
      this.evict(s.sessionId);
      throw err;
    }

    this.store.create(chatId);
    this.store.bindSession(chatId, s.sessionId);

    const name = sanitizeTitle(opts.title ?? '') || (opts.freshWorkspace ? '' : path.basename(s.cwd));
    if (name) {
      this.store.setTitle(chatId, name);
      s.title = name;
    }

    return this.buildDetail(this.store.get(chatId)!, s, []);
  }

  async runPrompt(
    chatId: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
  ): Promise<void> {
    const s = await this.ensureOpen(chatId);
    // A message typed mid-reload lands on the new process, not rejected.
    await this.settleReload(s);
    if (s.running) throw new Error('A turn is already running for this session');
    // Claimed before the spawn, so a reload can't drain it and dispose the
    // child this prompt is for.
    s.running = true;
    s.lastActivity = Date.now();

    let proc: ManagedProcess;
    try {
      proc = await this.ensureProc(s);
    } catch (err) {
      s.running = false;
      throw err;
    }
    // Only when nothing has named it yet.
    if (!this.store.getTitle(chatId)) {
      const title = titleFromPrompt(content);
      if (title) {
        this.store.setTitle(chatId, title);
        s.title = title;
      }
    }

    let recorded: MessageAttachment[] | undefined;
    if (attachments?.length) {
      const ordinal = await promptCount(s.sessionId);
      this.store.setAttachments(chatId, ordinal, attachments);
      recorded = attachments;
    }

    s.record({ kind: 'turn_started', prompt: content, attachments: recorded });

    proc
      .prompt({ sessionId: s.sessionId, prompt: content })
      .then((res) => {
        if (res.stopReason === 'cancelled') this.saveEnding(chatId, s.recorder.finish({ kind: 'interrupted' }));
        else s.recorder.discard();
        s.record({ kind: 'turn_ended', stopReason: res.stopReason });
      })
      .catch((err: Error) => {
        if (s.cancelRequested) {
          // The user stopped the turn and the process had to be killed to do it.
          this.saveEnding(chatId, s.recorder.finish({ kind: 'interrupted' }));
          s.record({ kind: 'turn_ended', stopReason: 'cancelled' });
          return;
        }
        this.log.error({ err, sessionId: s.sessionId }, 'prompt turn failed');
        // Appends kiro's stderr tail only if not already in the message.
        const tail = proc.stderrTail();
        const message =
          tail && !err.message.includes(tail)
            ? `${err.message}\n\nkiro-cli output:\n${tail}`
            : err.message;
        this.saveEnding(chatId, s.recorder.finish({ kind: 'failed', message }));
        s.record({ kind: 'turn_error', message });
      })
      .finally(() => {
        s.cancelRequested = false;
        clearTimeout(s.cancelTimer);
        s.cancelTimer = undefined;
        s.running = false;
        s.lastActivity = Date.now();
        if (s.subagents.turnEnded()) s.record({ kind: 'subagents_changed', subagents: s.subagents.list() });
      });
  }

  private saveEnding(chatId: string, ending: TurnEnding | null): void {
    if (!ending) return;
    try {
      this.store.addTurnEnding(chatId, ending);
    } catch (err) {
      this.log.error({ err, chatId }, 'could not store a failed turn');
    }
  }

  /**
   * Asks kiro to cancel the turn. If the turn has not ended within the grace period, kiro
   * has stopped handling the session (its agent loop can panic while the process stays
   * up), so the process is killed. Its exit then fails the pending prompt.
   */
  cancel(chatId: string): void {
    const s = this.sessions.get(this.store.sessionIdForChat(chatId) ?? '');
    const proc = s?.proc;
    if (!s || !proc) return;
    proc.cancel(s.sessionId);
    if (!s.running) return;
    s.cancelRequested = true;
    if (s.cancelTimer) return;
    s.cancelTimer = setTimeout(() => {
      s.cancelTimer = undefined;
      if (!s.running || s.proc !== proc) return;
      this.log.warn(
        { sessionId: s.sessionId, graceMs: this.cancelGraceMs },
        'turn did not end after cancel; killing kiro-cli',
      );
      proc.dispose();
    }, this.cancelGraceMs);
    s.cancelTimer.unref?.();
  }

  async setMode(chatId: string, modeId: string): Promise<void> {
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.setMode(s.sessionId, modeId);
    s.currentModeId = modeId;
    s.agentId = modeId;
    s.lastActivity = Date.now();
  }

  async setModel(chatId: string, modelId: string): Promise<void> {
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.setModel(s.sessionId, modelId);
    s.modelId = modelId;
    s.lastActivity = Date.now();
  }

  /** Runs one of kiro's slash commands. Compaction is the only one Casper offers. It
   *  returns once kiro has started; its progress arrives as compaction events. */
  async execCommand(chatId: string, command: string): Promise<void> {
    if (command.replace(/^\//, '') !== 'compact') throw new Error(`Unsupported command: ${command}`);
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    if (s.turnState.get().compacting) throw new Error('The conversation is already being compacted');
    const proc = await this.ensureProc(s);
    s.lastActivity = Date.now();
    const status = (type: 'started' | 'completed' | 'failed'): CasperEventPayload => ({
      kind: 'compaction',
      params: { sessionId: s.sessionId, status: { type }, summary: null },
    });
    // kiro reports only the end of a compaction it was asked for.
    s.record(status('started'));
    proc.compact(s.sessionId).then(
      () => {
        // Its summary normally arrives first; this covers one that ended without it.
        if (s.turnState.get().compacting && s.proc === proc) s.record(status('completed'));
      },
      (err: Error) => {
        this.log.warn({ err, sessionId: s.sessionId }, 'compaction failed');
        if (s.turnState.get().compacting && s.proc === proc) s.record(status('failed'));
      },
    );
  }

  /** The one place a ChatSummary is assembled, since kiro's file and Casper's
   *  live state each hold part of the truth. */
  private summaryOf(
    chat: ChatRow,
    live: Session | undefined,
    persisted: PersistedSession | undefined,
    transcript?: TranscriptItem[],
  ): ChatSummary {
    const snap = live?.turnState.get();
    const cwd = live?.cwd ?? chat.cwd ?? persisted?.cwd ?? config.defaultCwd;

    return {
      chatId: chat.chatId,
      sessionId: live?.sessionId ?? chat.sessionId ?? undefined,
      title: this.titleOf(chat, {
        kiroTitle: persisted?.title || live?.title,
        firstPrompt: transcript && firstPromptText(transcript),
        cwd,
      }),
      cwd,
      createdAt: persisted?.createdAt ?? live?.createdAt ?? new Date().toISOString(),
      updatedAt: live
        ? newerOf(persisted?.updatedAt, live.updatedAt)
        : (persisted?.updatedAt ?? new Date().toISOString()),
      liveness: live?.proc ? 'live' : 'dormant',
      agentId: live?.agentId ?? persisted?.agentId,
      modelId: live?.modelId ?? persisted?.modelId,
      running: live?.running ?? false,
      // A dormant session falls back to kiro's file.
      contextUsagePercentage:
        snap?.contextUsagePercentage || persisted?.contextUsagePercentage,
    };
  }

  async listChats(): Promise<ChatSummary[]> {
    const rows = this.store.all();
    const files = await readPersistedSessions(
      rows.map((r) => r.sessionId).filter((id): id is string => !!id),
    );

    const out: ChatSummary[] = [];
    rows.forEach((row) => {
      const live = row.sessionId ? this.sessions.get(row.sessionId) : undefined;
      const persisted = row.sessionId ? files.get(row.sessionId) : undefined;
      if (live && isGhost(live, !!persisted)) {
        this.evict(live.sessionId);
        return;
      }
      if (!persisted && !live) return;
      out.push(this.summaryOf(row, live, persisted));
    });
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** kiro's session id for a chat, or a throw if the chat is unknown. */
  private sessionIdOf(chatId: string): string {
    const sessionId = this.store.sessionIdForChat(chatId);
    if (!sessionId) throw new Error(`Unknown chat: ${chatId}`);
    return sessionId;
  }

  private hydrate(chatId: string, sessionId: string): Promise<TranscriptItem[]> {
    return hydrateTranscript(
      sessionId,
      this.store.attachmentsByChat(chatId),
      this.store.turnEndingsByChat(chatId),
    );
  }

  async getDetail(chatId: string): Promise<ChatDetail> {
    const chat = this.store.get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    const sessionId = chat.sessionId;

    const [transcript, persisted] = await Promise.all([
      sessionId
        ? this.hydrate(chatId, sessionId)
        : Promise.resolve([]),
      sessionId ? readPersistedSession(sessionId, { contextUsage: true }) : Promise.resolve(null),
    ]);

    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!s && !persisted) throw new Error(`Unknown chat: ${chatId}`);
    return this.buildDetail(chat, s, transcript, persisted ?? undefined);
  }

  /** A transcript slice for lazy "load older on scroll up". offset/limit are
   *  clamped to the transcript bounds. */
  async getTranscriptPage(
    chatId: string,
    offset: number,
    limit: number,
  ): Promise<TranscriptItem[]> {
    const transcript = await this.hydrate(chatId, this.sessionIdOf(chatId));
    const start = Math.max(0, Math.min(offset, transcript.length));
    const end = Math.max(start, Math.min(start + limit, transcript.length));
    return transcript.slice(start, end);
  }

  /**
   * A chat's subagents: the ones kiro V3 recorded in the session's file, the child
   * sessions kiro 2.x left for its older turns, and live ones from the tracker. A live row
   * wins over the file's until the file records how the subagent ended.
   */
  async getSubagents(chatId: string): Promise<SubagentSummary[]> {
    const sessionId = this.sessionIdOf(chatId);
    const live = this.sessions.get(sessionId)?.subagents.list() ?? [];
    const [recorded, children] = await Promise.all([listSubExecutions(sessionId), this.v2Subagents(sessionId)]);

    const byId = new Map<string, SubagentSummary>(children.map((c) => [c.sessionId, c]));
    const finished = new Set<string>();
    for (const sub of recorded ?? []) {
      byId.set(sub.sessionId, subExecutionSummary(sub));
      if (!sub.stopped) finished.add(sub.sessionId);
    }
    for (const a of live) if (!finished.has(a.sessionId)) byId.set(a.sessionId, a);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The child sessions kiro 2.x wrote for a session's subagents. A child the tracker never
   * saw falls back to a recorded link or title matching (subagentFallbackMatch.ts).
   */
  private async v2Subagents(sessionId: string): Promise<SubagentSummary[]> {
    const onDisk = await listChildSessions(sessionId);
    if (onDisk.length === 0) return [];
    const links = this.subagentLinks.forParent(sessionId);
    const tried = this.unmatchedChildren.get(sessionId) ?? new Set<string>();
    const unresolved = onDisk.filter((c) => !links.has(c.sessionId) && !tried.has(c.sessionId));
    const fallback = unresolved.length
      ? matchSubagentsFallback(subagentCallsIn(await hydrateTranscript(sessionId)), unresolved)
      : [];
    const fallbackByChild = new Map(fallback.map((m) => [m.sessionId, m]));
    // Saved so the parent transcript is not read again for these children.
    for (const m of fallback) this.subagentLinks.record(m.sessionId, sessionId, m.toolCallId, m.stageName);
    for (const c of unresolved) if (!fallbackByChild.has(c.sessionId)) tried.add(c.sessionId);
    this.unmatchedChildren.set(sessionId, tried);

    return onDisk.map((child) => {
      const link = links.get(child.sessionId) ?? fallbackByChild.get(child.sessionId);
      return {
        sessionId: child.sessionId,
        stageName: link?.stageName ?? (child.title || child.sessionId),
        toolCallId: link?.toolCallId,
        status: 'completed',
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      };
    });
  }

  /** One subagent's own transcript, hydrated the same way a chat's is. */
  // Polled while a subagent runs, so it reads only the subagent's own files.
  async getSubagentDetail(chatId: string, subagentId: string): Promise<SubagentDetailResponse> {
    const parentSessionId = this.sessionIdOf(chatId);
    const live = this.sessions.get(parentSessionId)?.subagents.get(subagentId);
    const recorded = (await listSubExecutions(parentSessionId))?.find((x) => x.sessionId === subagentId);
    if (live || recorded) {
      // kiro creates the subagent's file with its first entry, a moment after it starts.
      const transcript = (await hydrateSubExecution(parentSessionId, subagentId)) ?? [];
      const subagent = recorded && (!live || !recorded.stopped) ? subExecutionSummary(recorded) : live!;
      return { subagent, transcript };
    }

    const child = await readChildSession(subagentId, parentSessionId);
    if (!child) throw new Error(`Unknown subagent: ${subagentId}`);
    const link = this.subagentLinks.forParent(parentSessionId).get(subagentId);
    const summary: SubagentSummary = {
      sessionId: subagentId,
      stageName: link?.stageName ?? (child.title || subagentId),
      toolCallId: link?.toolCallId,
      status: 'completed',
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
    };
    const transcript = showSummaryAsAnswer(await hydrateTranscript(subagentId));
    return { subagent: summary, transcript };
  }

  /** One projection, so a dormant session and a live one cannot disagree. */
  private buildDetail(
    chat: ChatRow,
    s: Session | undefined,
    hydrated: ChatDetail['transcript'],
    persisted?: PersistedSession,
  ): ChatDetail {
    const { transcript, head } = this.resumePoint(s, hydrated);
    return {
      summary: this.summaryOf(chat, s, persisted, hydrated),
      modes: s?.availableModes ?? [],
      currentModeId: s?.currentModeId ?? persisted?.agentId,
      transcript: transcript.slice(-TRANSCRIPT_PAGE_SIZE),
      transcriptTotal: transcript.length,
      observability: s?.turnState.get() ?? {
        ...emptyObservabilitySnapshot(),
        contextUsagePercentage: persisted?.contextUsagePercentage ?? 0,
      },
      head,
    };
  }

  /**
   * Where a reconnecting client picks up: the transcript, and the cursor its events replay
   * after. A turn in flight replays whole from its turn_started and is left out of the
   * transcript, since kiro writes the prompt at once but a tool call only once it ends, so
   * kiro's copy of the turn lacks whatever is still running.
   */
  private resumePoint(
    s: Session | undefined,
    transcript: ChatDetail['transcript'],
  ): { transcript: ChatDetail['transcript']; head: number } {
    if (!s) return { transcript, head: 0 };
    const head = s.store.head();
    if (!s.running) return { transcript, head };
    const { events } = s.store.getSince(0);
    let started: CasperEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.payload.kind === 'turn_started') {
        started = events[i];
        break;
      }
    }
    // A turn longer than the event buffer can only resume from the files.
    if (!started || started.payload.kind !== 'turn_started') return { transcript, head };
    const promptText = stripAttachmentsLine(
      started.payload.prompt
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ).trim();
    let cut = transcript.length;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const it = transcript[i]!;
      if (it.type === 'message' && it.message.role === 'user') {
        if (promptText && it.message.text.trim() === promptText) cut = i;
        break;
      }
    }
    return { transcript: transcript.slice(0, cut), head: started.seq - 1 };
  }

  evict(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.proc?.dispose();
    s.store.dispose();
  }

  // Evicts from memory, removes on-disk files and the chat's directory.
  async deleteChat(chatId: string): Promise<void> {
    const sessionId = this.store.sessionIdForChat(chatId);
    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    // kiro flushes its session file on shutdown; wait for exit or its write
    // recreates the files.
    if (s?.proc) {
      await s.proc.disposeAndWait().catch(() => {});
      s.proc = undefined;
      s.running = false;
    }
    this.store.remove(chatId);
    await removeChatDir(chatId);
    if (!sessionId) return;
    this.evict(sessionId);
    await deletePersistedSession(sessionId);
    // kiro-cli's wrapped child can flush just after our delete; sweep once more.
    setTimeout(() => void deletePersistedSession(sessionId).catch(() => {}), 2500).unref?.();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.evict(id);
  }
}
