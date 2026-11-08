import {
  ACP_METHODS,
  contextBreakdownOf,
  emptyObservabilitySnapshot,
  KIRO_AGENT_NOT_FOUND,
  stripAttachmentsLine,
  type AgentMode,
  type CasperEvent,
  type AccountUsage,
  type CasperEventPayload,
  type ChatUsageResponse,
  type Memory,
  type KiroUpdateMeta,
  type MessageAttachment,
  type JsonRpcNotification,
  type PromptContentBlock,
  type ChatDetail,
  type SessionForkParams,
  type SessionLoadParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type ChatSummary,
  type SessionConfigOption,
  type SessionInfoUpdate,
  type SessionUpdate,
  type SessionUpdateParams,
  type SubagentDetailResponse,
  type TurnStats,
  type SubagentSummary,
  type TranscriptItem,
  type TurnEnding,
  resolveSessionTitle,
  sanitizeTitle,
} from '@casper/shared';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { invalidateAgents, rememberModes } from './agents.js';
import { chatDir, chatWorkspaceDir, createChatWorkspace, isManagedWorkspace, removeChatDir } from './chats.js';
import { rememberKiroModels } from './kiroModels.js';
import type { Logger } from '../util/logger.js';
import { isWithinRoot, isValidChatId } from '../util/paths.js';
import { KiroProcess } from './KiroProcess.js';
import { EventStore } from './EventStore.js';
import { TurnState } from './TurnState.js';
import { TurnRecorder } from './TurnRecorder.js';
import { SubagentTracker } from './SubagentTracker.js';
import {
  deletePersistedSession,
  hydrateSubExecution,
  hydrateTranscript,
  isLoadable,
  listSubExecutions,
  promptCount,
  promptStamps,
  readPersistedSession,
  readPersistedSessions,
  sessionCredits,
  STAMP_PAD_MS,
  type PersistedSession,
  type SubExecution,
} from './kiroFiles.js';
import { ChatStore, type ChatRow } from './chatStore.js';

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
  setEffort(sessionId: string, effortLevel: string): Promise<unknown>;
  forkSession(params: SessionForkParams): Promise<{ sessionId: string }>;
  steer(sessionId: string, message: string, messageId: string): Promise<string | undefined>;
  clearSteers(sessionId: string): Promise<unknown>;
  revertTo(sessionId: string, messageId: string): Promise<boolean>;
  contextBreakdown(sessionId: string): Promise<Record<string, { percent?: number } | undefined> | undefined>;
  accountUsage(): Promise<unknown>;
  listMemories(): Promise<unknown>;
  deleteMemory(id: string): Promise<unknown>;
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
  /** The effort a new chat on a model gets when none was picked. */
  defaultEffort?: (modelId: string | undefined) => Promise<string | undefined>;
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
  effortLevel?: string;
  currentModeId?: string;
  availableModes: AgentMode[] = [];
  // Set on a session that starts as a copy of another's conversation, cut after the
  // turn of the prompt `messageId`.
  forkOf?: { sessionId: string; messageId: string };
  // Credits used, as kiro last reported them.
  credits?: number;
  // The latest turn: its prompt's id once kiro names it, whether anything came of it, and
  // whether it failed. A retry rewinds a failed turn that left nothing.
  lastTurn?: { messageId?: string; output: boolean; failed: boolean };
  // Messages sent into the running turn that the model has not read yet, by kiro's id.
  readonly steers = new Map<string, { text: string; clientId?: string }>();
  // What the running turn took, from kiro's turn_completion.
  turnStats?: TurnStats;
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
    case 'context_usage': {
      if (typeof info.usagePercentage !== 'number') return null;
      const contextBreakdown = contextBreakdownOf(info.breakdown);
      return {
        kind: 'metadata',
        params: { sessionId, contextUsagePercentage: info.usagePercentage, ...(contextBreakdown ? { contextBreakdown } : {}) },
      };
    }
    case 'focus_update': {
      const title = sanitizeTitle(info.title ?? '');
      return title ? { kind: 'title_changed', title } : null;
    }
    case 'session_usage': {
      const total = (info.credits ?? []).reduce((sum, c) => sum + (typeof c?.usage === 'number' ? c.usage : 0), 0);
      return info.credits?.length ? { kind: 'metadata', params: { sessionId, sessionCredits: total } } : null;
    }
    case 'user_message_id_assigned':
      return typeof info.userMessageId === 'string' && info.userMessageId
        ? { kind: 'prompt_id', messageId: info.userMessageId }
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

/** The model and effort kiro reports a session is using. The effort is null for a model
 *  without effort levels, since kiro then offers no effort option. */
function sessionSettings(
  options: SessionConfigOption[] | undefined,
): { modelId?: string; effortLevel: string | null } | undefined {
  if (!options) return undefined;
  return {
    modelId: options.find((o) => o.id === 'model')?.currentValue,
    effortLevel: options.find((o) => o.id === 'effortLevel')?.currentValue ?? null,
  };
}

/** What a turn took, from kiro's `turn_completion`. Undefined when it reports neither. */
function turnStatsOf(info: { promptTurnSummaries?: { usage?: number; unit?: string }[]; elapsedTime?: number }): TurnStats | undefined {
  const credits = (info.promptTurnSummaries ?? []).reduce(
    (sum, t) => sum + (typeof t?.usage === 'number' && Number.isFinite(t.usage) ? t.usage : 0),
    0,
  );
  const elapsedMs = typeof info.elapsedTime === 'number' && info.elapsedTime > 0 ? info.elapsedTime : undefined;
  if (!credits && !elapsedMs) return undefined;
  return { ...(elapsedMs ? { elapsedMs } : {}), ...(credits > 0 ? { credits } : {}) };
}

/** The plan in kiro's `_kiro/account/getUsage` answer, if it has one. */
function accountUsageOf(raw: unknown): AccountUsage | undefined {
  const data = (raw as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data || typeof data.planName !== 'string') return undefined;
  const credits = (Array.isArray(data.usageBreakdowns) ? data.usageBreakdowns : []).find(
    (b: { resourceType?: unknown }) => b?.resourceType === 'CREDIT',
  ) as Record<string, unknown> | undefined;
  if (!credits || typeof credits.used !== 'number') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    planName: data.planName,
    used: credits.used,
    ...(credits.hasLimit !== false && num(credits.limit) !== undefined ? { limit: num(credits.limit) } : {}),
    ...(typeof data.billingCycleReset === 'string' ? { resetsOn: data.billingCycleReset } : {}),
    ...(num(credits.overageCharges) ? { overageCharges: num(credits.overageCharges) } : {}),
    ...(typeof credits.currency === 'string' ? { currency: credits.currency } : {}),
  };
}

/** The memories in kiro's `_kiro/memory/list` answer. */
function memoriesOf(raw: unknown): Memory[] {
  const list = (raw as { memories?: unknown } | undefined)?.memories;
  if (!Array.isArray(list)) return [];
  const out: Memory[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (typeof m?.id !== 'string') continue;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    out.push({
      id: m.id,
      memoryType: str(m.memoryType) ?? '',
      title: str(m.title) ?? '',
      summary: str(m.summary) ?? '',
      ...(Array.isArray(m.scopes) ? { scopes: m.scopes.filter((x): x is string => typeof x === 'string') } : {}),
      ...(str(m.updatedAt) ?? str(m.createdAt) ? { updatedAt: str(m.updatedAt) ?? str(m.createdAt) } : {}),
    });
  }
  return out;
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
  const first = transcript.find((it) => it.type === 'message' && it.message.role === 'user' && !it.message.steer);
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
  private readonly spawnProcess: SpawnProcess;
  private readonly cancelGraceMs: number;
  private readonly defaultModel: () => Promise<string | undefined>;
  private readonly defaultEffort: (modelId: string | undefined) => Promise<string | undefined>;

  constructor(log: Logger, opts: SessionManagerOptions = {}) {
    this.log = log;
    this.spawnProcess = opts.spawn ?? ((o, l) => new KiroProcess(o, l));
    this.cancelGraceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.defaultModel = opts.defaultModel ?? (async () => undefined);
    this.defaultEffort = opts.defaultEffort ?? (async () => undefined);
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
    s.effortLevel = persisted.effortLevel;
    s.createdAt = persisted.createdAt;
    s.updatedAt = persisted.updatedAt;
    s.markLive();
    s.turnState.seed(persisted.contextUsagePercentage ?? 0);
    this.sessions.set(sessionId, s);
    return s;
  }

  private wire(s: Session, proc: ManagedProcess): void {
    proc.on('notification', (n: JsonRpcNotification) => {
      // A load replays the session's credits, which nothing else reports until the next turn.
      const replayed = (n.params as SessionUpdateParams | undefined)?.update;
      if (s.replaying || kiroMeta(replayed ?? { sessionUpdate: '' })?.replay) {
        if (replayed?.sessionUpdate === 'session_info_update' && (replayed as SessionInfoUpdate)._meta?.kiro?.kind === 'session_usage') {
          const payload = sessionInfoEvent(s.sessionId, replayed as SessionInfoUpdate);
          if (payload?.kind === 'metadata') s.credits = payload.params.sessionCredits;
          if (payload) s.record(payload);
        }
        return;
      }
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
        const info = (update as SessionInfoUpdate)._meta?.kiro;
        if (info?.kind === 'steering_injected' || info?.kind === 'steering_cleared') {
          this.steerSettled(s, info.kind === 'steering_injected', info.kind === 'steering_injected' ? [info.messageId] : (info.messageIds ?? []));
          return;
        }
        if (info?.kind === 'turn_completion') {
          s.turnStats = turnStatsOf(info);
          return;
        }
        const payload = sessionInfoEvent(s.sessionId, update as SessionInfoUpdate);
        if (payload?.kind === 'prompt_id' && s.lastTurn) s.lastTurn.messageId = payload.messageId;
        if (payload?.kind === 'metadata' && payload.params.sessionCredits !== undefined) {
          s.credits = payload.params.sessionCredits;
        }
        if (payload?.kind === 'title_changed') {
          if (payload.title === s.title) return;
          s.title = payload.title;
        }
        if (payload) s.record(payload);
        return;
      }
      if (update.sessionUpdate === 'config_option_update') {
        const options = (update as { configOptions?: SessionConfigOption[] }).configOptions;
        rememberKiroModels(options);
        const settings = sessionSettings(options);
        if (!settings) return;
        const modelId = settings.modelId ?? s.modelId;
        const effortLevel = settings.effortLevel ?? undefined;
        if (modelId === s.modelId && effortLevel === s.effortLevel) return;
        s.modelId = modelId;
        s.effortLevel = effortLevel;
        s.record({ kind: 'settings_changed', modelId, effortLevel: settings.effortLevel });
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
      if (s.lastTurn) s.lastTurn.output = true;
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
      } else if (s.forkOf) {
        // kiro answers a fork with the new id alone, so the copy is then loaded for its
        // modes and settings. Its history is already in kiro's file, so the replay is skipped.
        const { sessionId } = await proc.forkSession({
          sessionId: s.forkOf.sessionId,
          cwd: s.cwd,
          mcpServers: [],
          _meta: { kiro: { messageId: s.forkOf.messageId } },
        });
        s.replaying = true;
        try {
          res = { ...(await proc.loadSession({ sessionId, cwd: s.cwd, mcpServers: [] })), sessionId };
        } finally {
          s.replaying = false;
        }
        res = await this.applyForkSettings(proc, s, res);
      } else {
        res = await proc.newSession({
          cwd: s.cwd,
          mcpServers: [],
          _meta: { kiro: { modeId: s.agentId, modelId: s.modelId, effortLevel: s.effortLevel } },
        });
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
      const settings = sessionSettings(res.configOptions);
      if (settings) {
        s.modelId = settings.modelId ?? s.modelId;
        s.effortLevel = settings.effortLevel ?? undefined;
      }
      rememberModes(res.modes.availableModes);
      rememberKiroModels(res.configOptions);
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

  /** A fork starts on kiro's default mode and model, so the ones the chat had are set
   *  again. Returns the session as it now is. */
  private async applyForkSettings(proc: ManagedProcess, s: Session, res: SessionNewResult): Promise<SessionNewResult> {
    const got = sessionSettings(res.configOptions);
    let changed = false;
    if (s.agentId && res.modes.currentModeId !== s.agentId) {
      await proc.setMode(res.sessionId, s.agentId);
      res = { ...res, modes: { ...res.modes, currentModeId: s.agentId } };
    }
    if (s.modelId && got?.modelId !== s.modelId) {
      await proc.setModel(res.sessionId, s.modelId);
      changed = true;
    }
    if (s.effortLevel && (changed || got?.effortLevel !== s.effortLevel)) {
      await proc.setEffort(res.sessionId, s.effortLevel);
      changed = true;
    }
    // The options kiro sent with the load are out of date now, so the ones just set are kept.
    return changed ? { ...res, configOptions: undefined } : res;
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

  /** Creates a new session. Spawns immediately to get a real kiro sessionId. It has no
   *  Casper title, so kiro's own title names it once kiro has made one. */
  async createChat(opts: {
    cwd?: string;
    agentId?: string;
    modelId?: string;
    effortLevel?: string;
    freshWorkspace?: boolean;
    chatId?: string;
  }): Promise<ChatDetail> {
    const chatId = isValidChatId(opts.chatId) ? opts.chatId : crypto.randomUUID();
    const cwd = opts.freshWorkspace ? createChatWorkspace(chatId) : resolveCwd(opts.cwd);
    const modelId = opts.modelId ?? (await this.defaultModel());
    const s = await this.startSession(new EventStore(chatId), cwd, {
      agentId: opts.agentId ?? config.defaultAgent,
      modelId,
      effortLevel: opts.effortLevel ?? (await this.defaultEffort(modelId)),
    });
    this.store.create(chatId);
    this.store.bindSession(chatId, s.sessionId);
    return this.buildDetail(this.store.get(chatId)!, s, []);
  }

  /** Starts a kiro session, new or forked, and holds it in memory under kiro's id. */
  private async startSession(
    store: EventStore,
    cwd: string,
    init: { agentId?: string; modelId?: string; effortLevel?: string; forkOf?: Session['forkOf'] },
  ): Promise<Session> {
    // Temporary local id until kiro assigns the real one during ensureProc.
    const tempId = `pending-${crypto.randomUUID()}`;
    const s = new Session(tempId, store, cwd);
    s.agentId = init.agentId;
    s.currentModeId = init.agentId;
    s.modelId = init.modelId;
    s.effortLevel = init.effortLevel;
    s.forkOf = init.forkOf;
    this.sessions.set(tempId, s);
    try {
      await this.ensureProc(s); // adopts kiro's real sessionId
    } catch (err) {
      // Drop the orphan so it can't leak or show up as a dead, unopenable row. The store
      // may belong to a chat that goes on, so it is left alone.
      this.sessions.delete(s.sessionId);
      s.proc?.dispose();
      throw err;
    }
    return s;
  }

  /**
   * A new chat holding this chat's conversation up to and including the turn of the
   * prompt `messageId`. A workspace Casper made is copied with it, so either chat can be
   * deleted without taking the other's files.
   */
  async branchChat(chatId: string, messageId: string): Promise<ChatDetail> {
    const parent = await this.ensureOpen(chatId);
    await this.settleReload(parent);
    const prompts = await promptStamps(parent.sessionId);
    const at = prompts.findIndex((p) => p.id === messageId);
    if (at < 0) throw new Error(`Unknown message: ${messageId}`);

    const branchId = crypto.randomUUID();
    const fromDir = chatDir(chatId);
    const toDir = chatDir(branchId);
    const ownWorkspace = parent.cwd === chatWorkspaceDir(chatId);
    await fs.promises.cp(fromDir, toDir, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    let s: Session;
    try {
      s = await this.startSession(new EventStore(branchId), ownWorkspace ? createChatWorkspace(branchId) : parent.cwd, {
        agentId: parent.agentId,
        modelId: parent.modelId,
        effortLevel: parent.effortLevel,
        forkOf: { sessionId: parent.sessionId, messageId },
      });
    } catch (err) {
      await removeChatDir(branchId);
      throw err;
    }

    this.store.create(branchId);
    this.store.bindSession(branchId, s.sessionId);
    const parentRow = this.store.get(chatId);
    if (parentRow?.title) this.store.setTitle(branchId, parentRow.title);
    if (parentRow?.cwd && !ownWorkspace) this.store.setCwd(branchId, parentRow.cwd);
    const cutAt = prompts[at + 1]?.atMs;
    this.store.copyHistory(
      chatId,
      branchId,
      { prompts: at + 1, before: cutAt === undefined ? undefined : cutAt - STAMP_PAD_MS },
      (p) => (p.startsWith(fromDir + path.sep) ? toDir + p.slice(fromDir.length) : p),
    );
    return this.getDetail(branchId);
  }

  /**
   * Cuts this chat back to before the prompt `messageId`, so it can be sent again. kiro
   * cannot shorten a session, so the chat moves to a new kiro session holding the turns
   * before it, and the old session stays in kiro's store.
   */
  async rewindChat(chatId: string, messageId: string): Promise<ChatDetail> {
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    if (s.running) throw new Error('Cannot rewind while a turn is running');
    if (s.turnState.get().compacting) throw new Error('Cannot rewind while the conversation is being compacted');
    const prompts = await promptStamps(s.sessionId);
    const at = prompts.findIndex((p) => p.id === messageId);
    if (at < 0) throw new Error(`Unknown message: ${messageId}`);

    const next = await this.startSession(s.store, s.cwd, {
      agentId: s.agentId,
      modelId: s.modelId,
      effortLevel: s.effortLevel,
      forkOf: at > 0 ? { sessionId: s.sessionId, messageId: prompts[at - 1]!.id } : undefined,
    });
    const old = s.proc;
    s.proc = undefined;
    this.sessions.delete(s.sessionId);

    this.store.bindSession(chatId, next.sessionId);
    this.store.dropHistory(chatId, { prompts: at, from: (prompts[at]!.atMs ?? Date.now()) - STAMP_PAD_MS });
    next.record({ kind: 'history_replaced' });
    this.log.info({ chatId, from: s.sessionId, to: next.sessionId }, 'chat rewound');
    // Nothing refers to the old session now. kiro writes its file again on exit, so it is
    // deleted only once the process is gone, and once more a moment later.
    await old?.disposeAndWait().catch(() => {});
    await this.forgetSession(s.sessionId);
    return this.getDetail(chatId);
  }

  async runPrompt(
    chatId: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
    opts: { retry?: boolean } = {},
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
    if (opts.retry) await this.dropFailedTurn(chatId, s, proc);
    s.lastTurn = { output: false, failed: false };
    s.turnStats = undefined;
    let recorded: MessageAttachment[] | undefined;
    if (attachments?.length) {
      const ordinal = await promptCount(s.sessionId);
      this.store.setAttachments(chatId, ordinal, attachments);
      recorded = attachments;
    }

    s.record({ kind: 'turn_started', prompt: content, attachments: recorded });

    proc
      .prompt({ sessionId: s.sessionId, prompt: content })
      .then(async (res) => {
        if (res.stopReason === 'cancelled') this.saveEnding(chatId, s.recorder.finish({ kind: 'interrupted' }));
        else s.recorder.discard();
        if (s.lastTurn) s.lastTurn.failed = res.stopReason === 'cancelled';
        await this.dropSteers(s, proc);
        const stats = s.turnStats;
        s.turnStats = undefined;
        s.record({ kind: 'turn_ended', stopReason: res.stopReason, ...(stats ? { stats } : {}) });
      })
      .catch(async (err: Error) => {
        if (s.lastTurn) s.lastTurn.failed = true;
        s.turnStats = undefined;
        await this.dropSteers(s, proc);
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

  /** Sends a message into the running turn. It shows in the chat once the model reads it,
   *  as a `steer_injected` event; one the turn ends without reading comes back as
   *  `steer_dropped`. */
  async steer(chatId: string, text: string, clientId?: string): Promise<void> {
    const s = this.sessions.get(this.store.sessionIdForChat(chatId) ?? '');
    const message = text.trim();
    if (!message) throw new Error('The message is empty');
    const proc = s?.proc;
    if (!s || !proc || !s.running || s.cancelRequested) throw new Error('No turn is running');
    // Registered under the id kiro is given before it is sent, since kiro can read the
    // message before its answer arrives.
    const id = crypto.randomUUID();
    const entry = { text: message, ...(clientId ? { clientId } : {}) };
    s.steers.set(id, entry);
    try {
      const kiroId = await proc.steer(s.sessionId, message, id);
      if (kiroId && kiroId !== id && s.steers.delete(id)) s.steers.set(kiroId, entry);
    } catch (err) {
      s.steers.delete(id);
      throw err;
    }
  }

  /** kiro read the steers `ids` into the turn, or dropped them. kiro names a steer
   *  `steer-<the id it was given>`. */
  private steerSettled(s: Session, injected: boolean, ids: (string | undefined)[]): void {
    for (const raw of ids) {
      if (!raw) continue;
      const id = s.steers.has(raw) ? raw : raw.replace(/^steer-/, '');
      const entry = s.steers.get(id);
      if (!entry) continue;
      s.steers.delete(id);
      s.record({ kind: injected ? 'steer_injected' : 'steer_dropped', text: entry.text, ...(entry.clientId ? { clientId: entry.clientId } : {}) });
      if (injected && s.lastTurn) s.lastTurn.output = true;
    }
  }

  /** At a turn's end, drops the steers the model never read, so none waits in kiro for a
   *  later turn the user did not mean it for. */
  private async dropSteers(s: Session, proc: ManagedProcess): Promise<void> {
    if (s.steers.size === 0) return;
    await proc.clearSteers(s.sessionId).catch(() => {});
    this.steerSettled(s, false, [...s.steers.keys()]);
  }

  /**
   * Before a retry, removes the failed turn it retries when kiro kept nothing of it but the
   * prompt, so the model does not read that prompt twice. A turn that did anything is left:
   * kiro's rewind would also undo the files it changed.
   */
  private async dropFailedTurn(chatId: string, s: Session, proc: ManagedProcess): Promise<void> {
    const last = s.lastTurn;
    if (!last?.failed || last.output || !last.messageId) return;
    s.lastTurn = undefined;
    try {
      const stamps = await promptStamps(s.sessionId);
      const ordinal = stamps.findIndex((p) => p.id === last.messageId);
      if (ordinal < 0 || !(await proc.revertTo(s.sessionId, last.messageId))) return;
      // The retry takes its place, so what Casper kept of it goes too: its attachments and
      // the stored ending. Clients refetch the shorter history.
      this.store.dropHistory(chatId, { prompts: ordinal, from: (stamps[ordinal]!.atMs ?? Date.now()) - STAMP_PAD_MS });
      s.record({ kind: 'history_replaced' });
      this.log.info({ chatId, messageId: last.messageId }, 'failed turn removed before its retry');
    } catch (err) {
      this.log.warn({ err, chatId }, 'could not remove the failed turn before its retry');
    }
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

  async setEffort(chatId: string, effortLevel: string): Promise<void> {
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    await proc.setEffort(s.sessionId, effortLevel);
    s.effortLevel = effortLevel;
    s.lastActivity = Date.now();
  }

  /**
   * What the chat has cost and the plan it counts against. Asks kiro for the context
   * breakdown too, which it reports only during a turn, and records it as metadata. Both
   * need a kiro process, so a dormant chat is started.
   */
  async getUsage(chatId: string): Promise<ChatUsageResponse> {
    const s = await this.ensureOpen(chatId);
    await this.settleReload(s);
    const proc = await this.ensureProc(s);
    s.lastActivity = Date.now();
    const [raw, account, filed] = await Promise.all([
      proc.contextBreakdown(s.sessionId).catch(() => undefined),
      this.accountUsage(proc),
      sessionCredits(s.sessionId).catch(() => undefined),
    ]);
    const contextBreakdown = contextBreakdownOf(raw);
    if (contextBreakdown) s.record({ kind: 'metadata', params: { sessionId: s.sessionId, contextBreakdown } });
    const credits = Math.max(s.credits ?? 0, filed ?? 0);
    return { ...(s.credits !== undefined || filed !== undefined ? { credits } : {}), ...(account ? { account } : {}) };
  }

  // The plan changes slowly and each read is a call to kiro's service, so it is kept a minute.
  private account?: { at: number; value: AccountUsage | undefined };

  private async accountUsage(proc: ManagedProcess): Promise<AccountUsage | undefined> {
    if (this.account && Date.now() - this.account.at < 60_000) return this.account.value;
    const value = accountUsageOf(await proc.accountUsage().catch(() => undefined));
    this.account = { at: Date.now(), value };
    return value;
  }

  /** kiro's saved memories. They are the user's, not a chat's, so any process will do. */
  listMemories(): Promise<Memory[]> {
    return this.withAnyProcess(async (proc) => memoriesOf(await proc.listMemories()));
  }

  deleteMemory(id: string): Promise<void> {
    return this.withAnyProcess(async (proc) => {
      await proc.deleteMemory(id);
    });
  }

  /** Runs on a live kiro process, or on one started for the call and stopped after it. */
  private async withAnyProcess<T>(run: (proc: ManagedProcess) => Promise<T>): Promise<T> {
    const live = [...this.sessions.values()].find((s) => s.proc)?.proc;
    if (live) return run(live);
    const proc = this.spawnProcess({ cwd: config.defaultCwd }, this.log);
    try {
      await proc.initialize();
      return await run(proc);
    } finally {
      proc.dispose();
    }
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
        // A live session hears kiro's new title before kiro writes its file.
        kiroTitle: live?.title || persisted?.title,
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
      effortLevel: live ? live.effortLevel : persisted?.effortLevel,
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
    const transcript = await this.hydrate(chatId, this.sessionIdOf(chatId));
    const start = Math.max(0, Math.min(offset, transcript.length));
    const end = Math.max(start, Math.min(start + limit, transcript.length));
    return transcript.slice(start, end);
  }

  /** A chat's subagents: the ones kiro recorded in the session's file, and live ones from
   *  the tracker. A live row wins over the file's until the file records how it ended. */
  async getSubagents(chatId: string): Promise<SubagentSummary[]> {
    const sessionId = this.sessionIdOf(chatId);
    const live = this.sessions.get(sessionId)?.subagents.list() ?? [];
    const byId = new Map<string, SubagentSummary>();
    const finished = new Set<string>();
    for (const sub of (await listSubExecutions(sessionId)) ?? []) {
      byId.set(sub.sessionId, subExecutionSummary(sub));
      if (!sub.stopped) finished.add(sub.sessionId);
    }
    for (const a of live) if (!finished.has(a.sessionId)) byId.set(a.sessionId, a);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** One subagent's own transcript, hydrated the same way a chat's is. */
  // Polled while a subagent runs, so it reads only the subagent's own files.
  async getSubagentDetail(chatId: string, subagentId: string): Promise<SubagentDetailResponse> {
    const parentSessionId = this.sessionIdOf(chatId);
    const live = this.sessions.get(parentSessionId)?.subagents.get(subagentId);
    const recorded = (await listSubExecutions(parentSessionId))?.find((x) => x.sessionId === subagentId);
    if (!live && !recorded) throw new Error(`Unknown subagent: ${subagentId}`);
    // kiro creates the subagent's file with its first entry, a moment after it starts.
    const transcript = (await hydrateSubExecution(parentSessionId, subagentId)) ?? [];
    const subagent = recorded && (!live || !recorded.stopped) ? subExecutionSummary(recorded) : live!;
    return { subagent, transcript };
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
      if (it.type === 'message' && it.message.role === 'user' && !it.message.steer) {
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
    await this.forgetSession(sessionId);
  }

  /** Deletes a session's files from kiro's store. */
  private async forgetSession(sessionId: string): Promise<void> {
    await deletePersistedSession(sessionId).catch((err: Error) => {
      this.log.warn({ err, sessionId }, 'could not delete a kiro session');
    });
    // kiro-cli's wrapped child can flush just after our delete; sweep once more.
    setTimeout(() => void deletePersistedSession(sessionId).catch(() => {}), 2500).unref?.();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.evict(id);
  }
}
