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
  type PromptContentBlock,
  type SessionDetail,
  type SessionLoadParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionSummary,
  type SessionUpdateParams,
  type TranscriptItem,
  resolveSessionTitle,
  sanitizeTitle,
  titleFromPrompt,
} from '@casper/shared';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { invalidateAgents } from './agents.js';
import { createChatWorkspace, isManagedWorkspace } from './chats.js';
import type { Logger } from '../util/logger.js';
import { isWithinRoot, isValidChatId } from '../util/paths.js';
import { KiroProcess } from './KiroProcess.js';
import { EventStore } from './EventStore.js';
import { TurnState } from './TurnState.js';
import {
  deletePersistedSession,
  hasRecordedTurns,
  hydrateTranscript,
  promptCount,
  listPersistedSessions,
  readPersistedSession,
} from './kiroFiles.js';
import { SessionStore } from './sessionStore.js';

// Resolve a working directory for a new session as an absolute path (relative input against
// DEFAULT_CWD), created if missing, rejected if it exists as a file. Confined to
// config.fileRoot so a session - and the file endpoints scoped to it - can't reach arbitrary
// locations such as /etc or SSH keys.
function resolveCwd(input?: string): string {
  const raw = input?.trim();
  const abs = raw ? path.resolve(config.defaultCwd, raw) : config.defaultCwd;

  // Confine to fileRoot. Blocks ../ traversal and out-of-root absolute paths.
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

/**
 * The process surface SessionManager drives. Wide because it genuinely uses all
 * of it, not because KiroProcess is shallow - and a seam this shape is what lets
 * eviction, capacity and session-id adoption be tested without spawning anything.
 */
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
  /** Substitute the child process. Defaults to a real kiro-cli. */
  spawn?: SpawnProcess;
}

// A session's server-side state. The store, turn state, and metadata exist as
// soon as it's opened; the kiro-cli child (`proc`) is spawned lazily, only when
// an action needs it. Viewing a session never spawns a process.
export class Session {
  readonly sessionId: string;
  readonly store: EventStore;
  readonly turnState = new TurnState();
  cwd: string;
  /** The chat that owns this session's uploads. See chats.ts. */
  chatId?: string;
  agentId?: string;
  modelId?: string;
  currentModeId?: string;
  availableModes: AgentMode[] = [];
  /** Empty until something names it; resolveSessionTitle owns the fallback. */
  title = '';
  createdAt = new Date().toISOString();
  updatedAt = new Date().toISOString();
  lastActivity = Date.now();
  running = false;
  // True once kiro has created or loaded this session id.
  private everLive = false;

  proc?: ManagedProcess;
  // In-flight spawn, so concurrent actions share one process.
  spawning?: Promise<ManagedProcess>;
  /**
   * Set while this session's process is being replaced, and resolved when the
   * replacement is ready. Claimed synchronously with the reload's guard, so an
   * action arriving during one waits for the new process instead of acting on the
   * one about to be disposed.
   */
  reloading?: Promise<void>;
  // True while kiro is replaying history during session/load. The transcript is
  // already hydrated from disk, so replayed notifications must not be appended
  // to the live store (doing so floods the chat with duplicate tool calls).
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

  /**
   * Single append path: fold the event into the live snapshot AND persist/fan
   * it out. Using this everywhere keeps turnState in sync with the event log,
   * so a client that refetches mid-turn sees turnStatus 'running' rather than
   * a stale 'idle'.
   */
  record(payload: CasperEventPayload): CasperEvent {
    // Any event is activity: without this, updatedAt stayed at whatever it was when
    // the session was opened, and the detail reported a time older than the list.
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

// How many transcript items to send on initial load / per older-page fetch.
// A large session's full transcript is multiple MB; loading just the tail keeps
// opening it fast, and the client fetches older pages on scroll-to-top.
const TRANSCRIPT_PAGE_SIZE = 80;

/** The later of two ISO timestamps: kiro's file and our own activity each move separately. */
function newerOf(a: string | undefined, b: string): string {
  return a && a.localeCompare(b) > 0 ? a : b;
}

/** The first user message in a transcript, if it has one. */
function firstPromptText(transcript: TranscriptItem[]): string | undefined {
  const first = transcript.find((it) => it.type === 'message' && it.message.role === 'user');
  return first?.type === 'message' ? first.message.text : undefined;
}

/**
 * A session kiro created or loaded, now with no file and no process, was deleted out from
 * under us. Left in memory it re-lists forever. One kiro never touched isn't a ghost: a
 * brand-new session has no file yet.
 */
function isGhost(s: Session, hasFile: boolean): boolean {
  return !hasFile && s.hasBeenLive && !s.proc;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly store = new SessionStore();
  private readonly spawnProcess: SpawnProcess;

  constructor(log: Logger, opts: SessionManagerOptions = {}) {
    this.log = log;
    this.spawnProcess = opts.spawn ?? ((o, l) => new KiroProcess(o, l));
  }

  /**
   * What a session is called, from every read path. The folder is skipped for a workspace of
   * ours, whose name is a uuid.
   */
  private titleOf(
    sessionId: string,
    parts: { kiroTitle?: string; firstPrompt?: string; cwd: string },
  ): string {
    return resolveSessionTitle({
      override: this.store.getTitle(sessionId),
      kiroTitle: parts.kiroTitle,
      firstPrompt: parts.firstPrompt,
      folder: isManagedWorkspace(parts.cwd) ? undefined : path.basename(parts.cwd),
    });
  }

  /** Set a user title override for a session. */
  renameSession(sessionId: string, title: string): void {
    const clean = sanitizeTitle(title);
    this.store.setTitle(sessionId, clean);
    const s = this.sessions.get(sessionId);
    if (s) s.title = clean || s.title;
  }

  /**
   * Re-point a session at a different working directory, for when the original was moved
   * or deleted. Validates and creates the target exactly like a new session's cwd, so a
   * folder is only created on this explicit action. Any live process was spawned with the
   * old cwd, so it is disposed and the next turn respawns in the new one, transcript intact.
   */
  async setSessionCwd(sessionId: string, input: string): Promise<string> {
    const resolved = resolveCwd(input);

    // Confirm the session exists before recording an override for it.
    const s = await this.ensureOpen(sessionId);

    this.store.setCwd(sessionId, resolved);
    if (s.cwd !== resolved) {
      s.cwd = resolved;
      // The child was started in the old directory; drop it so the next prompt
      // spawns a fresh process in the new one.
      s.proc?.dispose();
      s.proc = undefined;
      this.log.info({ sessionId, cwd: resolved }, 'session working directory changed');
    }
    return resolved;
  }

  /**
   * Restart the session's kiro child, so everything kiro only reads when a child
   * starts is read again: the agent definition, the workspace's `.kiro` directory,
   * and the MCP servers kiro launches for itself.
   *
   * No ACP method does this. kiro advertises no reload command, and `session/set_mode`
   * leaves the MCP servers it started alone, so replacing the process is the only
   * way - the transcript comes back with `session/load`.
   *
   * The old child is awaited out before the new one starts, because kiro flushes its
   * session file on shutdown and the replacement reads that file to reload the
   * conversation. Respawned eagerly rather than at the next prompt, so the caller
   * gets a detail that reflects what the fresh process reported.
   *
   * Needs a session that has recorded a turn, so it can be loaded back. Verified
   * against kiro 2.11: loading one with an empty event log fails with "Session not
   * found", and kiro deletes both its files when that process exits.
   */
  async reloadSession(sessionId: string): Promise<SessionDetail> {
    const s = await this.ensureOpen(sessionId);
    // Guard and claim in one tick. Every await below yields, and a check-then-act
    // guard excluded nothing: a prompt arriving in one of those gaps used to start a
    // turn on the very process this is about to dispose, killing it mid-flight.
    if (s.running) {
      throw new Error('Cannot reload while a turn is running');
    }
    // Compaction isn't a turn, so s.running says nothing about it. Replacing the process
    // mid-compaction loses the work and leaves the compacting flag set, which disables the
    // composer - and this reload would then hand that snapshot straight back to the client.
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
      return await this.replaceProcess(s);
    } finally {
      // Cleared before waking anyone, so a waiter never sees a stale claim.
      s.reloading = undefined;
      ready();
    }
  }

  /** The reload itself. Only ever called with the session's reload claim held. */
  private async replaceProcess(s: Session): Promise<SessionDetail> {
    if (!(await hasRecordedTurns(s.sessionId))) {
      throw new Error(
        'kiro has not saved this session yet. Send a message first, then reload.',
      );
    }
    // A spawn already in flight would otherwise be handed back below as the
    // "reloaded" process, or race the one this starts.
    if (s.spawning) await s.spawning.catch(() => {});

    const old = s.proc;
    if (old) {
      // Cleared before the wait so the exit handler sees a replaced process and
      // records no process_exited: this restart is deliberate, not a crash.
      s.proc = undefined;
      await old.disposeAndWait().catch(() => {});
    }
    // Whatever the last process reported is now stale; the new one re-reports.
    s.availableModes = [];
    await this.ensureProc(s);
    s.lastActivity = Date.now();
    // The agent list is read from kiro, not from the session, and reloading is
    // exactly when a newly created agent should show up.
    invalidateAgents();
    this.log.info({ sessionId: s.sessionId, cwd: s.cwd }, 'session reloaded');
    return this.getDetail(s.sessionId);
  }

  /**
   * Wait out a reload before touching the session's process. Without this an action
   * can be handed the process that the reload is about to dispose.
   */
  private async settleReload(s: Session): Promise<void> {
    if (s.reloading) await s.reloading;
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.proc) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Event subscription - works for any opened session, spawned or not.
  // -------------------------------------------------------------------------

  onEvent(sessionId: string, cb: (e: CasperEvent) => void): (() => void) | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    s.store.on('event', cb);
    return () => s.store.off('event', cb);
  }

  getStore(sessionId: string): EventStore | undefined {
    return this.sessions.get(sessionId)?.store;
  }

  /** Get a session's working directory. Opens the session in memory if needed. */
  async getSessionCwd(sessionId: string): Promise<string> {
    const s = await this.ensureOpen(sessionId);
    return s.cwd;
  }

  /** Open a session in memory (store + metadata) WITHOUT spawning a process. */
  async ensureOpen(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const persisted = await readPersistedSession(sessionId);
    if (!persisted) throw new Error(`Unknown session: ${sessionId}`);

    // A session's cwd is persisted by kiro at creation. If the user re-pointed
    // the session (original folder moved or deleted), the Casper-side override
    // wins.
    const effectiveCwd = this.store.getCwd(sessionId) ?? persisted.cwd;

    // Confine the persisted cwd to fileRoot. A session created before this
    // boundary existed - or one created directly by kiro-cli - could carry an
    // out-of-root cwd; the workspace endpoints scope file access to it, so an
    // unbounded cwd would re-open the arbitrary-read hole. Fail closed.
    if (!isWithinRoot(config.fileRoot, effectiveCwd)) {
      throw new Error(
        `Session working directory is outside the allowed root: ${effectiveCwd}`,
      );
    }

    const store = new EventStore(sessionId);
    const s = new Session(sessionId, store, effectiveCwd);
    s.title = persisted.title;
    s.agentId = persisted.agentId;
    s.currentModeId = persisted.agentId;
    s.modelId = persisted.modelId;
    s.createdAt = persisted.createdAt;
    s.updatedAt = persisted.updatedAt;
    s.markLive(); // it exists on disk, so kiro can load it on demand
    s.turnState.seed(persisted.contextUsagePercentage ?? 0);
    this.sessions.set(sessionId, s);
    return s;
  }

  // -------------------------------------------------------------------------
  // Lazy process spawning
  // -------------------------------------------------------------------------

  private wire(s: Session, proc: ManagedProcess): void {
    proc.on('notification', (n: JsonRpcNotification) => {
      // Drop kiro's history replay during session/load: the transcript is
      // already hydrated from disk, so appending these would duplicate every
      // past message and tool call into the live chat.
      if (s.replaying) return;
      const payload = mapNotification(n);
      if (!payload) return;
      s.record(payload);
    });
    proc.on('exit', (code: number | null, signal: string | null) => {
      // Only the session's current process should mutate its state. A process
      // that failed to initialize (never became s.proc) or was replaced after
      // eviction must not record a spurious process_exited event.
      if (s.proc !== proc) return;
      s.record({ kind: 'process_exited', code, signal });
      s.proc = undefined;
      s.running = false;
    });
  }

  /** Get (or spawn + initialize + create/load) the kiro process for a session. */
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

      // Load the existing session if kiro already knows it, else create it.
      // session/load makes kiro replay the whole conversation as notifications;
      // gate them out of the store while it runs (see Session.replaying).
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

      // A brand-new session gets kiro's generated id; adopt it if it differs.
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

  // -------------------------------------------------------------------------
  // Creating / opening
  // -------------------------------------------------------------------------

  /** Create a new session. Spawns immediately so we get a real kiro sessionId. */
  async createSession(opts: {
    cwd?: string;
    agentId?: string;
    modelId?: string;
    freshWorkspace?: boolean;
    title?: string;
    chatId?: string;
  }): Promise<SessionDetail> {
    // The client's chat id, which already owns any files uploaded to this chat before it
    // sent. Absent only if something other than the web app created the session.
    const chatId = isValidChatId(opts.chatId) ? opts.chatId : crypto.randomUUID();
    // A workspace of its own is created before the spawn, so kiro starts in it directly.
    const cwd = opts.freshWorkspace ? createChatWorkspace(chatId) : resolveCwd(opts.cwd);
    // Temporary local id until kiro assigns the real one during ensureProc.
    const tempId = `pending-${Date.now()}-${Math.floor(this.sessions.size)}`;
    const store = new EventStore(tempId);
    const s = new Session(tempId, store, cwd);
    s.agentId = opts.agentId ?? config.defaultAgent;
    s.currentModeId = s.agentId;
    s.modelId = opts.modelId;
    this.sessions.set(tempId, s);

    try {
      await this.ensureProc(s); // adopts kiro's real sessionId
    } catch (err) {
      // Spawn or handshake failed: drop the orphan so it can't leak or show up
      // as a dead, unopenable row in the session list.
      this.evict(s.sessionId);
      throw err;
    }


    // Name the session before it is returned, so it is never listed as untitled: the
    // caller's title if it has one - a draft knows its first prompt - otherwise the folder
    // the user chose. Stored as a Casper title override; the user can rename.
    // Bind the chat to kiro's session id now that it has one, so later uploads land in the
    // same directory as any the draft already made.
    this.store.setChatId(s.sessionId, chatId);
    s.chatId = chatId;

    const name = sanitizeTitle(opts.title ?? '') || (opts.freshWorkspace ? '' : path.basename(s.cwd));
    if (name) {
      this.store.setTitle(s.sessionId, name);
      s.title = name;
    }

    return this.buildDetail(s, []);
  }

  // -------------------------------------------------------------------------
  // Actions - these spawn the process lazily.
  // -------------------------------------------------------------------------

  async runPrompt(
    sessionId: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
  ): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    // Held rather than rejected: a message typed while the process is being replaced
    // should land on the new one, not bounce back at the user.
    await this.settleReload(s);
    if (s.running) throw new Error('A turn is already running for this session');
    // Claimed before the spawn rather than after it. Bringing a dormant session up takes
    // seconds, and a reload entering that gap saw no turn, drained this spawn, and then
    // disposed the very child this prompt was about to be sent to.
    s.running = true;
    s.lastActivity = Date.now();

    let proc: ManagedProcess;
    try {
      proc = await this.ensureProc(s);
    } catch (err) {
      // Nothing to run the turn on, so release the claim or the session looks busy
      // forever and can never be reloaded either.
      s.running = false;
      throw err;
    }
    // Named before the turn is announced, so a client reacting to turn_started already
    // sees it. Only when nothing has named it yet: a title the user set, or one taken
    // from a chosen working directory, is theirs to keep.
    if (!this.store.getTitle(s.sessionId)) {
      const title = titleFromPrompt(content);
      if (title) {
        this.store.setTitle(s.sessionId, title);
        s.title = title;
      }
    }

    // Only counted when there is something to record, so an ordinary prompt pays nothing.
    let recorded: MessageAttachment[] | undefined;
    if (attachments?.length) {
      const ordinal = await promptCount(s.sessionId);
      this.store.setAttachments(s.sessionId, ordinal, attachments);
      recorded = attachments;
    }

    s.record({ kind: 'turn_started', prompt: content, attachments: recorded });

    proc
      .prompt({ sessionId: s.sessionId, prompt: content })
      .then((res) => s.record({ kind: 'turn_ended', stopReason: res.stopReason }))
      .catch((err: Error) => {
        this.log.error({ err, sessionId: s.sessionId }, 'prompt turn failed');
        // If the failure didn't explain itself, kiro's own output usually has
        // something. Only appended when it isn't already in the message, so a
        // self-explaining error doesn't get the same text twice.
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

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    s?.proc?.cancel(s.sessionId);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.setMode(s.sessionId, modeId);
    s.currentModeId = modeId;
    s.agentId = modeId;
    s.lastActivity = Date.now();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.setModel(s.sessionId, modelId);
    s.modelId = modelId;
    s.lastActivity = Date.now();
  }

  async execCommand(sessionId: string, command: string): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.execCommand(s.sessionId, command);
    s.lastActivity = Date.now();
  }

  // -------------------------------------------------------------------------
  // Listing / detail - never spawns.
  // -------------------------------------------------------------------------

  /**
   * The one place a SessionSummary is assembled. kiro's file and Casper's live
   * state each hold part of the truth, so every read path - list, detail, and a
   * freshly created session - projects them through here rather than picking a
   * precedence per field on its own. Mirrors resolveSessionTitle, which already
   * owns the title half of the same decision.
   *
   * `persisted` is kiro's own summary, absent for a session with no file yet.
   * `live` is the in-memory session, absent for a dormant one. The overloads
   * require one of them, so the assertions below cannot fire.
   */
  private summaryOf(
    live: Session | undefined,
    persisted: SessionSummary | undefined,
    transcript?: TranscriptItem[],
  ): SessionSummary {
    const sessionId = live?.sessionId ?? persisted!.sessionId;
    const snap = live?.turnState.get();
    // A live session's cwd already carries the override, applied in ensureOpen.
    const cwd = live?.cwd ?? this.store.getCwd(sessionId) ?? persisted!.cwd;

    return {
      sessionId,
      chatId: live?.chatId ?? this.store.getChatId(sessionId),
      title: this.titleOf(sessionId, {
        // kiro's file is what kiro called it; the live copy is only a cache of it.
        kiroTitle: persisted?.title || live?.title,
        firstPrompt: transcript && firstPromptText(transcript),
        cwd,
      }),
      cwd,
      createdAt: persisted?.createdAt ?? live!.createdAt,
      // kiro's file and our own activity move separately.
      updatedAt: live ? newerOf(persisted?.updatedAt, live.updatedAt) : persisted!.updatedAt,
      liveness: live?.proc ? 'live' : 'dormant',
      agentId: live?.agentId ?? persisted?.agentId,
      modelId: live?.modelId ?? persisted?.modelId,
      running: live?.running ?? false,
      // A live snapshot starts at zero until the first turn reports, so a dormant
      // session's value comes from kiro's file.
      contextUsagePercentage:
        snap?.contextUsagePercentage || persisted?.contextUsagePercentage,
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const persisted = await listPersistedSessions(this.log);
    const files = new Map(persisted.map((p) => [p.sessionId, p]));
    const byId = new Map<string, SessionSummary>();
    for (const p of persisted) {
      byId.set(p.sessionId, this.summaryOf(undefined, p));
    }
    for (const s of this.sessions.values()) {
      if (isGhost(s, files.has(s.sessionId))) {
        this.evict(s.sessionId);
        continue;
      }
      byId.set(s.sessionId, this.summaryOf(s, files.get(s.sessionId)));
    }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getDetail(sessionId: string): Promise<SessionDetail> {
    // Both reads in parallel: a live session needs the file too, so its summary
    // gets the same fallbacks the list gives it and the two cannot disagree.
    const [transcript, persisted] = await Promise.all([
      hydrateTranscript(sessionId, this.store.attachmentsBySession(sessionId)),
      readPersistedSession(sessionId),
    ]);

    const s = this.sessions.get(sessionId);
    if (!s && !persisted) throw new Error(`Unknown session: ${sessionId}`);
    return this.buildDetail(s, transcript, persisted ?? undefined);
  }

  /**
   * A slice of the transcript for lazy "load older on scroll up". Re-hydrates
   * from disk (fast: ~150ms even for a multi-MB session) and returns the
   * requested window. offset/limit are clamped to the transcript bounds.
   */
  async getTranscriptPage(
    sessionId: string,
    offset: number,
    limit: number,
  ): Promise<TranscriptItem[]> {
    const transcript = await hydrateTranscript(
      sessionId,
      this.store.attachmentsBySession(sessionId),
    );
    const start = Math.max(0, Math.min(offset, transcript.length));
    const end = Math.max(start, Math.min(start + limit, transcript.length));
    return transcript.slice(start, end);
  }

  /** One projection, so a dormant session and a live one cannot disagree. */
  private buildDetail(
    s: Session | undefined,
    transcript: SessionDetail['transcript'],
    persisted?: SessionSummary,
  ): SessionDetail {
    return {
      summary: this.summaryOf(s, persisted, transcript),
      modes: s?.availableModes ?? [],
      currentModeId: s?.currentModeId ?? persisted?.agentId,
      // Only the tail is sent on load; replayHead/title use the full transcript.
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
   * The cursor a reconnecting client should start from. Normally the store head, but kiro writes
   * a turn to its jsonl only once the turn completes, so a hydrated transcript is missing one in
   * flight. Rewind to just before its turn_started and let the WS replay the whole turn. Guarded
   * against duplication in case kiro ever persists the prompt at turn start.
   */
  private replayHead(s: Session, transcript: SessionDetail['transcript']): number {
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
    // If the hydrated transcript already ends with this prompt, it's persisted
    // - don't replay it (would duplicate the user message).
    for (let i = transcript.length - 1; i >= 0; i--) {
      const it = transcript[i]!;
      if (it.type === 'message' && it.message.role === 'user') {
        if (promptText && it.message.text.trim() === promptText) return head;
        break;
      }
    }
    return started.seq - 1;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  evict(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.proc?.dispose();
    s.store.dispose();
  }

  // Permanently delete a session: evict it from memory, remove its on-disk
  // files, and drop any title override.
  async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    // kiro flushes its session file on shutdown, so wait for the process to
    // exit before deleting - otherwise its write recreates the files.
    if (s?.proc) {
      await s.proc.disposeAndWait().catch(() => {});
      s.proc = undefined;
      s.running = false;
    }
    this.evict(sessionId);
    this.store.remove(sessionId);
    await deletePersistedSession(sessionId);
    // kiro-cli spawns a wrapped kiro-cli-chat that flushes the session file on
    // its own shutdown, which can land just after our delete. Sweep once more
    // so a deleted session doesn't reappear.
    setTimeout(() => void deletePersistedSession(sessionId).catch(() => {}), 2500).unref?.();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.evict(id);
  }
}
