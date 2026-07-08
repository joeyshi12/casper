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

/** A single rendered entry in a session transcript. */
export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Concatenated text content. */
  text: string;
  timestamp?: number;
}

export interface SessionDetail {
  summary: SessionSummary;
  modes: AgentMode[];
  currentModeId?: string;
  transcript: TranscriptMessage[];
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

// ---------------------------------------------------------------------------
// Prompt (also available over WS; REST variant for fire-and-forget)
// ---------------------------------------------------------------------------

export interface PromptRequest {
  prompt: PromptContentBlock[];
}

export interface HealthResponse {
  status: 'ok';
  kiroVersion?: string;
  liveSessions: number;
  uptimeMs: number;
}
