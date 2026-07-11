import {
  emptyObservabilitySnapshot,
  KIRO_NOTIFICATIONS,
  type AgentMode,
  type CasperEvent,
  type CasperEventPayload,
  type JsonRpcNotification,
  type KiroCommandsAvailableParams,
  type KiroMcpServerParams,
  type KiroMetadataParams,
  type KiroOauthRequestParams,
  type KiroSubagentListParams,
  type PromptContentBlock,
  type SessionDetail,
  type SessionSummary,
  type SessionUpdateParams,
} from '@casper/shared';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { isWithinRoot } from '../util/paths.js';
import { KiroProcess } from './KiroProcess.js';
import { EventStore } from './EventStore.js';
import { TurnState } from './TurnState.js';
import {
  deletePersistedSession,
  hydrateTranscript,
  listPersistedSessions,
  readPersistedSession,
} from './kiroFiles.js';
import { TitleStore } from './titles.js';

// Resolve a working directory for a new session, normalized to an absolute path
// (relative input is resolved against DEFAULT_CWD). If the directory doesn't
// exist it's created; a path that exists but is a file is rejected. The result
// is confined to config.fileRoot so a session's working directory - and thus
// the workspace file-serving endpoints scoped to it - can't reach arbitrary
// filesystem locations (e.g. /etc, SSH keys).
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

// A session's server-side state. The store, turn state, and metadata exist as
// soon as it's opened; the kiro-cli child (`proc`) is spawned lazily, only when
// an action needs it. Viewing a session never spawns a process.
class Session {
  readonly sessionId: string;
  readonly store: EventStore;
  readonly turnState = new TurnState();
  cwd: string;
  agentId?: string;
  modelId?: string;
  currentModeId?: string;
  availableModes: AgentMode[] = [];
  title = 'New session';
  createdAt = new Date().toISOString();
  updatedAt = new Date().toISOString();
  lastActivity = Date.now();
  running = false;
  // True once kiro has created or loaded this session id.
  private everLive = false;

  proc?: KiroProcess;
  // In-flight spawn, so concurrent actions share one process.
  spawning?: Promise<KiroProcess>;

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
}

/** Maps a raw ACP/kiro notification to a durable Casper event payload. */
function mapNotification(n: JsonRpcNotification): CasperEventPayload | null {
  switch (n.method) {
    case 'session/update':
      return { kind: 'session_update', update: (n.params as SessionUpdateParams).update };
    case KIRO_NOTIFICATIONS.metadata:
      return { kind: 'metadata', params: n.params as KiroMetadataParams };
    case KIRO_NOTIFICATIONS.subagentListUpdate:
      return { kind: 'subagent_update', params: n.params as KiroSubagentListParams };
    case KIRO_NOTIFICATIONS.mcpServerInitialized:
      return { kind: 'mcp_health', params: n.params as KiroMcpServerParams, ok: true };
    case KIRO_NOTIFICATIONS.mcpServerInitFailure:
      return { kind: 'mcp_health', params: n.params as KiroMcpServerParams, ok: false };
    case KIRO_NOTIFICATIONS.commandsAvailable:
      return { kind: 'commands_available', params: n.params as KiroCommandsAvailableParams };
    case KIRO_NOTIFICATIONS.mcpOauthRequest:
      return { kind: 'oauth_request', params: n.params as KiroOauthRequestParams };
    default:
      return null;
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly titles: TitleStore;

  constructor(log: Logger) {
    this.log = log;
    this.titles = new TitleStore(log);
  }

  /** Set a user title override for a session. */
  renameSession(sessionId: string, title: string): void {
    this.titles.set(sessionId, title);
    const s = this.sessions.get(sessionId);
    if (s) s.title = title.trim() || s.title;
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

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Open a session in memory (store + metadata) WITHOUT spawning a process. */
  async ensureOpen(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const persisted = await readPersistedSession(sessionId);
    if (!persisted) throw new Error(`Unknown session: ${sessionId}`);

    // Confine the persisted cwd to fileRoot. A session created before this
    // boundary existed - or one created directly by kiro-cli - could carry an
    // out-of-root cwd; the workspace endpoints scope file access to it, so an
    // unbounded cwd would re-open the arbitrary-read hole. Fail closed.
    if (!isWithinRoot(config.fileRoot, persisted.cwd)) {
      throw new Error(
        `Session working directory is outside the allowed root: ${persisted.cwd}`,
      );
    }

    const store = new EventStore(sessionId, this.log);
    const s = new Session(sessionId, store, persisted.cwd);
    s.title = persisted.title;
    s.agentId = persisted.agentId;
    s.currentModeId = persisted.agentId;
    s.modelId = persisted.modelId;
    s.createdAt = persisted.createdAt;
    s.updatedAt = persisted.updatedAt;
    s.markLive(); // it exists on disk, so kiro can load it on demand
    s.turnState.seed(
      persisted.creditsSpent ?? 0,
      persisted.contextUsagePercentage ?? 0,
    );
    this.sessions.set(sessionId, s);
    return s;
  }

  // -------------------------------------------------------------------------
  // Lazy process spawning
  // -------------------------------------------------------------------------

  private wire(s: Session, proc: KiroProcess): void {
    proc.on('notification', (n: JsonRpcNotification) => {
      const payload = mapNotification(n);
      if (!payload) return;
      s.turnState.apply(payload);
      s.store.append(payload);
    });
    proc.on('exit', (code: number | null, signal: string | null) => {
      s.store.append({ kind: 'process_exited', code, signal });
      s.proc = undefined;
      s.running = false;
    });
  }

  /** Get (or spawn + initialize + create/load) the kiro process for a session. */
  private async ensureProc(s: Session): Promise<KiroProcess> {
    if (s.proc) return s.proc;
    if (s.spawning) return s.spawning;

    s.spawning = (async () => {
      await this.ensureCapacity();
      const proc = new KiroProcess(
        { cwd: s.cwd, agent: s.agentId, model: s.modelId },
        this.log,
      );
      this.wire(s, proc);
      await proc.initialize();

      // Load the existing session if kiro already knows it, else create it.
      const res = s.hasBeenLive
        ? await proc.loadSession({ sessionId: s.sessionId, cwd: s.cwd, mcpServers: [] })
        : await proc.newSession({ cwd: s.cwd, mcpServers: [] });

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
  }): Promise<SessionDetail> {
    const cwd = resolveCwd(opts.cwd);
    // Temporary local id until kiro assigns the real one during ensureProc.
    const tempId = `pending-${Date.now()}-${Math.floor(this.sessions.size)}`;
    const store = new EventStore(tempId, this.log);
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
    return this.buildDetail(s, []);
  }

  // -------------------------------------------------------------------------
  // Actions - these spawn the process lazily.
  // -------------------------------------------------------------------------

  async runPrompt(sessionId: string, content: PromptContentBlock[]): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    const proc = await this.ensureProc(s);
    if (s.running) throw new Error('A turn is already running for this session');
    s.running = true;
    s.lastActivity = Date.now();
    s.store.append({ kind: 'turn_started', prompt: content });

    proc
      .prompt({ sessionId: s.sessionId, prompt: content })
      .then((res) => s.store.append({ kind: 'turn_ended', stopReason: res.stopReason }))
      .catch((err: Error) => {
        this.log.error({ err, sessionId: s.sessionId }, 'prompt turn failed');
        s.store.append({ kind: 'turn_error', message: err.message });
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
    const proc = await this.ensureProc(s);
    await proc.setMode(s.sessionId, modeId);
    s.currentModeId = modeId;
    s.agentId = modeId;
    s.lastActivity = Date.now();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    const proc = await this.ensureProc(s);
    await proc.setModel(s.sessionId, modelId);
    s.modelId = modelId;
    s.lastActivity = Date.now();
  }

  async execCommand(sessionId: string, command: string, args?: string): Promise<void> {
    const s = await this.ensureOpen(sessionId);
    const proc = await this.ensureProc(s);
    await proc.execCommand(s.sessionId, command, args);
    s.lastActivity = Date.now();
  }

  // -------------------------------------------------------------------------
  // Listing / detail - never spawns.
  // -------------------------------------------------------------------------

  async listSessions(): Promise<SessionSummary[]> {
    const persisted = await listPersistedSessions(this.log);
    const byId = new Map<string, SessionSummary>();
    for (const p of persisted) {
      byId.set(p.sessionId, { ...p, title: this.titles.get(p.sessionId) ?? p.title });
    }
    for (const s of this.sessions.values()) {
      const snap = s.turnState.get();
      const base = byId.get(s.sessionId);
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        title: this.titles.get(s.sessionId) ?? base?.title ?? s.title,
        cwd: s.cwd,
        createdAt: base?.createdAt ?? s.createdAt,
        updatedAt: base?.updatedAt ?? s.updatedAt,
        liveness: s.proc ? 'live' : 'dormant',
        agentId: s.agentId ?? base?.agentId,
        modelId: s.modelId ?? base?.modelId,
        running: s.running,
        creditsSpent: snap.creditsSpent || base?.creditsSpent,
        contextUsagePercentage:
          snap.contextUsagePercentage || base?.contextUsagePercentage,
      });
    }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getDetail(sessionId: string): Promise<SessionDetail> {
    const transcript = await hydrateTranscript(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) return this.buildDetail(s, transcript);

    const persisted = await readPersistedSession(sessionId);
    if (!persisted) throw new Error(`Unknown session: ${sessionId}`);
    return {
      summary: { ...persisted, title: this.titles.get(sessionId) ?? persisted.title },
      modes: [],
      currentModeId: persisted.agentId,
      transcript,
      observability: {
        ...emptyObservabilitySnapshot(),
        creditsSpent: persisted.creditsSpent ?? 0,
        contextUsagePercentage: persisted.contextUsagePercentage ?? 0,
      },
      head: 0,
    };
  }

  private buildDetail(
    s: Session,
    transcript: SessionDetail['transcript'],
  ): SessionDetail {
    const snap = s.turnState.get();
    const firstMessage = transcript.find((it) => it.type === 'message');
    const firstText =
      firstMessage?.type === 'message' ? firstMessage.message.text : undefined;
    return {
      summary: {
        sessionId: s.sessionId,
        title: this.titles.get(s.sessionId) ?? (firstText?.slice(0, 60) || s.title),
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        liveness: s.proc ? 'live' : 'dormant',
        agentId: s.agentId,
        modelId: s.modelId,
        running: s.running,
        creditsSpent: snap.creditsSpent,
        contextUsagePercentage: snap.contextUsagePercentage,
      },
      modes: s.availableModes,
      currentModeId: s.currentModeId,
      transcript,
      observability: snap,
      head: s.store.head(),
    };
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
    this.evict(sessionId);
    this.titles.remove(sessionId);
    await deletePersistedSession(sessionId);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.evict(id);
  }
}
