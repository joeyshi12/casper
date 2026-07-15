/**
 * REST DTOs - request/response shapes for the HTTP API.
 */

import type { AgentMode, PromptContentBlock } from './acp.js';
import type { ObservabilitySnapshot } from './observability.js';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionLiveness = 'live' | 'dormant';

export interface SessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  liveness: SessionLiveness;
  /** Current agent (mode) id, if known. */
  agentId?: string;
  /** Current model id, if known. */
  modelId?: string;
  /** Whether a turn is actively running server-side. */
  running: boolean;
  /** Cumulative credits spent (from live TurnState or persisted metadata). */
  creditsSpent?: number;
  contextUsagePercentage?: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface CreateSessionRequest {
  cwd?: string;
  agentId?: string;
  modelId?: string;
}

/** A message entry in a session transcript. */
export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  /** Concatenated text content. */
  text: string;
  timestamp?: number;
  /** Relative workspace paths of images attached to a user message. */
  imagePaths?: string[];
}

/** A tool-call entry in a session transcript (matches the live tool_call view). */
export interface TranscriptToolCall {
  id: string;
  title: string;
  kind?: string;
  status: string;
  input?: unknown;
  output?: unknown;
  content: unknown[];
}

/** A transcript entry: a message or an inline tool call. */
export type TranscriptItem =
  | { type: 'message'; message: TranscriptMessage }
  | { type: 'tool_call'; tool: TranscriptToolCall };

export interface SessionDetail {
  summary: SessionSummary;
  modes: AgentMode[];
  currentModeId?: string;
  transcript: TranscriptItem[];
  observability: ObservabilitySnapshot;
  /** Highest event seq currently in the server buffer (client's replay cursor start). */
  head: number;
}

export interface SetModelRequest {
  modelId: string;
}

export interface RenameSessionRequest {
  title: string;
}

export interface SetModeRequest {
  modeId: string;
}

// Prompt (also available over WS; REST variant for fire-and-forget)

export interface PromptRequest {
  prompt: PromptContentBlock[];
}

// Directory suggestions for the working-directory input.
export interface DirListing {
  /** Absolute directory that was listed. */
  dir: string;
  /** Absolute paths of matching subdirectories. */
  entries: string[];
}

// A logged-in device (from GET /api/devices).
export interface DeviceInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent?: string;
  /** True for the device making the request. */
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

// ---------------------------------------------------------------------------
// Workspace file tree
// ---------------------------------------------------------------------------

/** A single entry (file or directory) in the workspace tree listing. */
export interface FileEntry {
  /** File or directory name. */
  name: string;
  /** Path relative to the session's cwd. */
  path: string;
  type: 'file' | 'directory';
  /** Size in bytes (files only). */
  size?: number;
  /** ISO timestamp of last modification. */
  modifiedAt?: string;
}

/** Response from GET /api/sessions/:id/tree */
export interface TreeResponse {
  /** Absolute working directory of the session (for display). */
  cwd: string;
  /** The subdirectory that was listed (relative to cwd, empty string = root). */
  relativeTo: string;
  entries: FileEntry[];
}

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

/** How an uploaded file should be surfaced to the agent. */
export type UploadKind = 'image' | 'text' | 'binary';

/** Metadata for one stored upload (from POST /api/sessions/:id/uploads). */
export interface UploadedFile {
  /** Original (sanitized) filename. */
  name: string;
  /** Path relative to the session cwd, e.g. .casper/uploads/report.pdf */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Detected MIME type (best effort). */
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
