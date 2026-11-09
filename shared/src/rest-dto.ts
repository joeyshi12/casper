/** REST DTOs: request/response shapes for the HTTP API. */

import type { AgentMode, PromptContentBlock } from './acp.js';
import type { ObservabilitySnapshot } from './observability.js';

/** Mapped from `kiro-cli chat --list-models -f json`. */
export interface ModelInfo {
  modelId: string;
  modelName: string;
  description: string;
  contextWindowTokens: number;
  /** Credit rate multiplier, e.g. 2.2 for opus, 0.4 for haiku. */
  rateMultiplier: number;
  rateUnit: string;
  isDefault: boolean;
  /** Effort levels the model takes, lowest first. Absent for a model without them, and
   *  until a kiro session has reported them. */
  effortLevels?: string[];
  /** The level kiro recommends for the model. */
  recommendedEffort?: string;
  /** The level a new chat on this model gets: the user's own default from kiro's
   *  `chat.modelDefaults`, else the recommended one. */
  defaultEffort?: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

export interface AgentsResponse {
  agents: AgentMode[];
  defaultAgentId: string;
}

export type SessionLiveness = 'live' | 'dormant';

export interface ChatSummary {
  chatId: string;
  sessionId?: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  liveness: SessionLiveness;
  agentId?: string;
  modelId?: string;
  effortLevel?: string;
  running: boolean;
  pinned: boolean;
  contextUsagePercentage?: number;
}

export interface ChatListResponse {
  chats: ChatSummary[];
}

export interface CreateChatRequest {
  cwd?: string;
  agentId?: string;
  modelId?: string;
  effortLevel?: string;
  freshWorkspace?: boolean;
  /** The server generates one if absent or malformed. */
  chatId?: string;
}

/** One file attached to a prompt, recorded per message rather than parsed from the text. */
export interface MessageAttachment {
  path: string;
  name: string;
  size: number;
  kind: UploadKind;
}

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  text: string;
  timestamp?: number;
  attachments?: MessageAttachment[];
  /** kiro's id for a prompt, which a branch is cut at. */
  messageId?: string;
  /** Sent while a turn ran, into that turn. A steer is no prompt of its own, so it cannot
   *  be edited or branched from. */
  steer?: boolean;
}

/** What one turn took, shown under its reply. */
export interface TurnStats {
  elapsedMs?: number;
  credits?: number;
}

/** A tool-call entry in a session transcript. */
export interface TranscriptToolCall {
  id: string;
  /** A tool name where one is known: `server/tool` for MCP, `invoke_sub_agent` for a
   *  subagent, and kiro 2.x's names on calls kiro copied in from a 2.x session. kiro names
   *  none of its own built-in tools, which are told apart by kind and input. */
  name?: string;
  title: string;
  kind?: string;
  status: string;
  input?: unknown;
  output?: unknown;
  content: unknown[];
}

/** A failed turn is its own type rather than an assistant message, so it isn't
 *  attributed to the model and renders as raw output, not through markdown. */
export type TranscriptItem =
  | { type: 'message'; message: TranscriptMessage }
  | { type: 'tool_call'; tool: TranscriptToolCall }
  | { type: 'compaction'; id: string; summary: string; timestamp?: number }
  | { type: 'turn_error'; id: string; message: string; timestamp?: number }
  | { type: 'turn_interrupted'; id: string; timestamp?: number }
  | ({ type: 'turn_stats'; id: string } & TurnStats);

/** A turn that failed or was stopped, stored because kiro drops what it had in flight. */
export interface TurnEnding {
  startedAt: number;
  endedAt: number;
  prompt: string;
  kind: 'failed' | 'interrupted';
  /** The error text of a failed turn. */
  message?: string;
  /** Everything the turn showed after the prompt. */
  items: TranscriptItem[];
}

export interface StoredTurnEnding extends TurnEnding {
  id: number;
}

export interface ChatDetail {
  summary: ChatSummary;
  modes: AgentMode[];
  currentModeId?: string;
  transcript: TranscriptItem[];
  transcriptTotal: number;
  observability: ObservabilitySnapshot;
  head: number;
}

export interface TranscriptPageResponse {
  items: TranscriptItem[];
}

/** One subagent (child session) spawned by a chat's `subagent` tool call. */
export interface SubagentSummary {
  sessionId: string;
  stageName: string;
  /** Absent for one found only on disk after a restart lost the live link. */
  toolCallId?: string;
  status: 'pending' | 'working' | 'completed' | 'failed';
  /** One short phrase of what it's doing now, e.g. "Reading sprite-dom.ts" or "Done". */
  activity?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentListResponse {
  subagents: SubagentSummary[];
}

export interface SubagentDetailResponse {
  subagent: SubagentSummary;
  transcript: TranscriptItem[];
}

export interface SetModelRequest {
  modelId: string;
}

/** The user's kiro plan, and how much of it is used this billing cycle. */
export interface AccountUsage {
  planName: string;
  used: number;
  limit?: number;
  /** The day the count starts again, as YYYY-MM-DD. */
  resetsOn?: string;
  overageCharges?: number;
  currency?: string;
}

/** What a chat has cost, and the plan it counts against. */
export interface ChatUsageResponse {
  credits?: number;
  account?: AccountUsage;
}

/** One of kiro's saved memories. kiro's list leaves out each one's full text. */
export interface Memory {
  id: string;
  memoryType: string;
  title: string;
  summary: string;
  /** `Global`, `workspace:<name>` or `repo:<provider>/<owner>/<name>`. */
  scopes?: string[];
  updatedAt?: string;
}

export interface MemoryListResponse {
  memories: Memory[];
}

export interface SetEffortRequest {
  effortLevel: string;
}

/** A user message's `messageId`. Branching keeps that message's turn; rewinding drops
 *  the message and everything after it. */
export interface CutChatRequest {
  messageId: string;
}

export interface RenameChatRequest {
  title: string;
}

export interface PinChatRequest {
  pinned: boolean;
}

export interface SetCwdRequest {
  /** Absolute path, or relative to the server's DEFAULT_CWD. Created if absent. */
  cwd: string;
}

export interface SetModeRequest {
  modeId: string;
}

export interface PromptRequest {
  prompt: PromptContentBlock[];
  attachments?: MessageAttachment[];
}

export interface DirListing {
  dir: string;
  entries: string[];
  /** Resolved the same way session creation resolves it, against DEFAULT_CWD;
   *  may not exist yet. */
  target: string;
  /** 'missing' means creating a session there will create the folder; 'file'
   *  means create will reject it. */
  targetKind: 'directory' | 'file' | 'missing';
}

export interface DeviceInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent?: string;
  current: boolean;
}

export interface DevicesResponse {
  devices: DeviceInfo[];
}

export interface HealthResponse {
  status: 'ok';
  kiroVersion?: string;
  liveSessions: number;
  uptimeMs: number;
}

export interface FileEntry {
  name: string;
  /** Path relative to the session's cwd. */
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

export interface TreeResponse {
  cwd: string;
  /** The subdirectory listed, relative to cwd; empty string means root. */
  relativeTo: string;
  entries: FileEntry[];
}

/** How an uploaded file should be surfaced to the agent. */
export type UploadKind = 'image' | 'text' | 'binary';

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  kind: UploadKind;
  /** Best-effort triage for binaries: `file` output, sha256, sample strings. */
  triage?: {
    fileType?: string;
    sha256?: string;
    strings?: string[];
  };
}

export interface UploadResponse {
  files: UploadedFile[];
}
