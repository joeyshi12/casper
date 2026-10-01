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
  running: boolean;
  contextUsagePercentage?: number;
}

export interface ChatListResponse {
  chats: ChatSummary[];
}

export interface CreateChatRequest {
  cwd?: string;
  agentId?: string;
  modelId?: string;
  freshWorkspace?: boolean;
  /** The server generates one if absent or malformed. */
  chatId?: string;
  /** Names the session as it is created, so the row is never listed as untitled
   *  while the client waits on the first prompt. */
  title?: string;
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
}

/** A tool-call entry in a session transcript. */
export interface TranscriptToolCall {
  id: string;
  /** Canonical kiro tool name (shell/write/read/grep/todo_list). */
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
  | { type: 'turn_error'; id: string; message: string; timestamp?: number };

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

export interface RenameChatRequest {
  title: string;
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
