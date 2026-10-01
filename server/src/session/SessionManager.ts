import {
  emptyObservabilitySnapshot,
  KIRO_NOTIFICATIONS,
  stripAttachmentsLine,
  type AgentMode,
  type CasperEvent,
  type CasperEventPayload,
  type MessageAttachment,
  type JsonRpcNotification,
  type KiroCompactionStatusParams,
  type KiroMetadataParams,
  type KiroSubagentListUpdateParams,
  type PromptContentBlock,
  type ChatDetail,
  type SessionLoadParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type ChatSummary,
  type SessionUpdateParams,
  type SubagentDetailResponse,
  type SubagentSummary,
  type TranscriptItem,
  resolveSessionTitle,
  sanitizeTitle,
  titleFromPrompt,
} from '@casper/shared';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { invalidateAgents } from './agents.js';
import { createChatWorkspace, isManagedWorkspace, removeChatDir } from './chats.js';
import type { Logger } from '../util/logger.js';
import { isWithinRoot, isValidChatId } from '../util/paths.js';
import { KiroProcess } from './KiroProcess.js';
import { EventStore } from './EventStore.js';
import { TurnState } from './TurnState.js';
import { SubagentTracker, type SubagentStageInput } from './SubagentTracker.js';
import { showSummaryAsAnswer } from './subagentResult.js';
import { matchSubagentsFallback, subagentCallsIn } from './subagentFallbackMatch.js';
import {
  deletePersistedSession,
  hasRecordedTurns,
  hydrateTranscript,
  listChildSessions,
  promptCount,
  readPersistedSession,
  type PersistedSession,
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
  execCommand(sessionId: string, command: string): Promise<unknown>;
  dispose(): void;
  disposeAndWait(timeoutMs?: number): Promise<void>;
}

export type SpawnProcess = (
  opts: { cwd: string; agent?: string; model?: string },
  log: Logger,
) => ManagedProcess;

export interface SessionManagerOptions {
  spawn?: SpawnProcess;
}

// Store, turn state and metadata exist as soon as a session is opened; the
// kiro-cli child (`proc`) spawns lazily on first action.
export class Session {
  readonly sessionId: string;
  readonly store: EventStore;
  readonly turnState = new TurnState();
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
    return this.store.append(payload);
  }
}

/** Maps a raw ACP/kiro notification to a durable Casper event payload. */
function mapNotification(n: JsonRpcNotification): CasperEventPayload | null {
  switch (n.method) {
    case 'session/update':
      return { kind: 'session_update', update: (n.params as SessionUpdateParams).update };
    case KIRO_NOTIFICATIONS.metadata:
      return { kind: 'metadata', params: n.params as KiroMetadataParams };
    case KIRO_NOTIFICATIONS.compactionStatus:
      return { kind: 'compaction', params: n.params as KiroCompactionStatusParams };
    default:
      return null;
  }
}

/** The `sessionId` carried in a notification's params, if it has one. */
function notificationSessionId(n: JsonRpcNotification): string | undefined {
  const params = n.params as { sessionId?: string } | undefined;
  return params?.sessionId;
}

function subagentCallStages(update: { sessionUpdate: string; [k: string]: unknown }): {
  toolCallId: string;
  stages: SubagentStageInput[];
} | null {
  if (update.sessionUpdate !== 'tool_call') return null;
  const meta = (update as { _meta?: { kiro?: { toolName?: string } } })._meta;
  if (meta?.kiro?.toolName !== 'subagent') return null;
  const toolCallId = (update as { toolCallId?: string }).toolCallId;
  const rawInput = (update as { rawInput?: { stages?: unknown } }).rawInput;
  if (typeof toolCallId !== 'string' || !Array.isArray(rawInput?.stages)) return null;
  const stages = rawInput.stages.filter(
    (s): s is SubagentStageInput => typeof s === 'object' && s !== null && typeof (s as SubagentStageInput).name === 'string',
  );
  return { toolCallId, stages };
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
  private readonly spawnProcess: SpawnProcess;

  constructor(log: Logger, opts: SessionManagerOptions = {}) {
    this.log = log;
    this.spawnProcess = opts.spawn ?? ((o, l) => new KiroProcess(o, l));
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
    if (!(await hasRecordedTurns(s.sessionId))) {
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
    await this.ensureProc(s);
    s.lastActivity = Date.now();
    invalidateAgents();
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

    const persisted = await readPersistedSession(sessionId);
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

      // A per-process broadcast with no sessionId of its own; one kiro-cli
      // child per chat means it's always this chat's.
      if (n.method === KIRO_NOTIFICATIONS.subagentListUpdate) {
        const params = n.params as KiroSubagentListUpdateParams;
        const resolved = s.subagents.apply(params.subagents);
        for (const link of resolved) {
          this.subagentLinks.record(link.sessionId, s.sessionId, link.toolCallId, link.stageName);
        }
        s.record({ kind: 'subagents_changed', subagents: s.subagents.list() });
        return;
      }

      const notifSessionId = notificationSessionId(n);
      if (!notifSessionId || notifSessionId === s.sessionId) {
        const payload = mapNotification(n);
        if (!payload) return;
        if (payload.kind === 'session_update') {
          const call = subagentCallStages(payload.update as { sessionUpdate: string; [k: string]: unknown });
          if (call) s.subagents.callStarted(call.toolCallId, call.stages);
          const update = payload.update as { sessionUpdate: string; toolCallId?: string; status?: string };
          if (
            update.sessionUpdate === 'tool_call_update' &&
            typeof update.toolCallId === 'string' &&
            (update.status === 'completed' || update.status === 'failed')
          ) {
            s.subagents.callFinished(update.toolCallId);
          }
        }
        s.record(payload);
        return;
      }

      // A subagent's own notifications aren't recorded here.
    });
    proc.on('exit', (code: number | null, signal: string | null) => {
      if (s.proc !== proc) return;
      s.record({ kind: 'process_exited', code, signal });
      s.proc = undefined;
      s.running = false;
    });
  }

  /** Gets or spawns the kiro process for a session. */
  private async ensureProc(s: Session): Promise<ManagedProcess> {
    if (s.proc) return s.proc;
    if (s.spawning) return s.spawning;

    s.spawning = (async () => {
      await this.ensureCapacity();
      const proc = this.spawnProcess(
        { cwd: s.cwd, agent: s.agentId, model: s.modelId },
        this.log,
      );
      this.wire(s, proc);
      await proc.initialize();

      // session/load replays the conversation as notifications; gated out while it runs.
      let res: SessionNewResult;
      if (s.hasBeenLive) {
        s.replaying = true;
        try {
          res = await proc.loadSession({ sessionId: s.sessionId, cwd: s.cwd, mcpServers: [] });
        } finally {
          s.replaying = false;
        }
      } else {
        res = await proc.newSession({ cwd: s.cwd, mcpServers: [] });
      }

      // A brand-new session adopts kiro's generated id.
      if (!s.hasBeenLive && res.sessionId !== s.sessionId) {
        this.sessions.delete(s.sessionId);
        (s as { sessionId: string }).sessionId = res.sessionId;
        this.sessions.set(res.sessionId, s);
      }
      s.availableModes = res.modes.availableModes;
      s.currentModeId = res.modes.currentModeId;
      s.agentId = res.modes.currentModeId ?? s.agentId;
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
    s.modelId = opts.modelId;
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
      .then((res) => s.record({ kind: 'turn_ended', stopReason: res.stopReason }))
      .catch((err: Error) => {
        this.log.error({ err, sessionId: s.sessionId }, 'prompt turn failed');
        // Appends kiro's stderr tail only if not already in the message.
        const tail = proc.stderrTail();
        const message =
          tail && !err.message.includes(tail)
            ? `${err.message}\n\nkiro-cli output:\n${tail}`
            : err.message;
        s.record({ kind: 'turn_error', message });
      })
      .finally(() => {
        s.running = false;
        s.lastActivity = Date.now();
      });
  }

  cancel(chatId: string): void {
    const s = this.sessions.get(this.store.sessionIdForChat(chatId) ?? '');
    s?.proc?.cancel(s.sessionId);
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

  async execCommand(chatId: string, command: string): Promise<void> {
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.execCommand(s.sessionId, command);
    s.lastActivity = Date.now();
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
    const files = await Promise.all(
      rows.map((r) => (r.sessionId ? readPersistedSession(r.sessionId) : null)),
    );

    const out: ChatSummary[] = [];
    rows.forEach((row, i) => {
      const live = row.sessionId ? this.sessions.get(row.sessionId) : undefined;
      const persisted = files[i] ?? undefined;
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

  async getDetail(chatId: string): Promise<ChatDetail> {
    const chat = this.store.get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    const sessionId = chat.sessionId;

    const [transcript, persisted] = await Promise.all([
      sessionId
        ? hydrateTranscript(sessionId, this.store.attachmentsByChat(chatId))
        : Promise.resolve([]),
      sessionId ? readPersistedSession(sessionId) : Promise.resolve(null),
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
    const transcript = await hydrateTranscript(
      this.sessionIdOf(chatId),
      this.store.attachmentsByChat(chatId),
    );
    const start = Math.max(0, Math.min(offset, transcript.length));
    const end = Math.max(start, Math.min(start + limit, transcript.length));
    return transcript.slice(start, end);
  }

  /**
   * A chat's subagents: live ones from the tracker, joined with children found on disk.
   * A child the tracker never saw falls back to a recorded link or title matching
   * (subagentFallbackMatch.ts).
   */
  async getSubagents(chatId: string): Promise<SubagentSummary[]> {
    const sessionId = this.sessionIdOf(chatId);
    const s = this.sessions.get(sessionId);
    const live = s ? s.subagents.list() : [];
    const liveToolCalls = new Set(live.map((a) => a.toolCallId).filter((id): id is string => !!id));
    const pending = s
      ? [...liveToolCalls].flatMap((id) => s.subagents.listForCall(id).filter((a) => a.status === 'pending'))
      : [];

    const onDisk = await listChildSessions(sessionId);
    const links = this.subagentLinks.forParent(sessionId);
    const liveIds = new Set(live.map((a) => a.sessionId));
    const unresolved = onDisk.filter((c) => !liveIds.has(c.sessionId) && !links.has(c.sessionId));
    const fallback = unresolved.length
      ? matchSubagentsFallback(subagentCallsIn(await hydrateTranscript(sessionId)), unresolved)
      : [];
    const fallbackByChild = new Map(fallback.map((m) => [m.sessionId, m]));

    const byId = new Map<string, SubagentSummary>();
    for (const child of onDisk) {
      const link = links.get(child.sessionId) ?? fallbackByChild.get(child.sessionId);
      byId.set(child.sessionId, {
        sessionId: child.sessionId,
        stageName: link?.stageName ?? (child.title || child.sessionId),
        toolCallId: link?.toolCallId,
        status: 'completed',
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      });
    }
    for (const a of live) byId.set(a.sessionId, a);
    const startedThenPending = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [...startedThenPending, ...pending];
  }

  /** One subagent's own transcript, hydrated the same way a chat's is. */
  async getSubagentDetail(chatId: string, childSessionId: string): Promise<SubagentDetailResponse> {
    const parentSessionId = this.sessionIdOf(chatId);
    const subagents = await this.getSubagents(chatId);
    const summary = subagents.find((a) => a.sessionId === childSessionId);
    if (!summary) throw new Error(`Unknown subagent: ${childSessionId}`);
    const onDisk = await listChildSessions(parentSessionId);
    if (!onDisk.some((c) => c.sessionId === childSessionId)) {
      throw new Error(`Unknown subagent: ${childSessionId}`);
    }
    const transcript = showSummaryAsAnswer(await hydrateTranscript(childSessionId));
    return { subagent: summary, transcript };
  }

  /** One projection, so a dormant session and a live one cannot disagree. */
  private buildDetail(
    chat: ChatRow,
    s: Session | undefined,
    transcript: ChatDetail['transcript'],
    persisted?: PersistedSession,
  ): ChatDetail {
    return {
      summary: this.summaryOf(chat, s, persisted, transcript),
      modes: s?.availableModes ?? [],
      currentModeId: s?.currentModeId ?? persisted?.agentId,
      transcript: transcript.slice(-TRANSCRIPT_PAGE_SIZE),
      transcriptTotal: transcript.length,
      observability: s?.turnState.get() ?? {
        ...emptyObservabilitySnapshot(),
        contextUsagePercentage: persisted?.contextUsagePercentage ?? 0,
      },
      head: s ? this.replayHead(s, transcript) : 0,
    };
  }

  /**
   * The cursor a reconnecting client starts from: the store head, unless the in-flight
   * turn isn't in kiro's jsonl yet, in which case rewind to its turn_started.
   */
  private replayHead(s: Session, transcript: ChatDetail['transcript']): number {
    const head = s.store.head();
    if (!s.running) return head;
    const { events } = s.store.getSince(0);
    let started: CasperEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.payload.kind === 'turn_started') {
        started = events[i];
        break;
      }
    }
    if (!started || started.payload.kind !== 'turn_started') return head;
    const promptText = stripAttachmentsLine(
      started.payload.prompt
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ).trim();
    // Don't replay a prompt the hydrated transcript already ends with.
    for (let i = transcript.length - 1; i >= 0; i--) {
      const it = transcript[i]!;
      if (it.type === 'message' && it.message.role === 'user') {
        if (promptText && it.message.text.trim() === promptText) return head;
        break;
      }
    }
    return started.seq - 1;
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
