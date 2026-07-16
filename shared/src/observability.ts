/**
 * Observability types - the folded state Casper derives from the stream of
 * `_kiro.dev/*` notifications, surfaced in the UI's observability panel.
 */

import type { KiroCommand, KiroSubagent } from './acp.js';

export type TurnStatus = 'idle' | 'running' | 'cancelling';

export interface McpServerHealth {
  serverName: string;
  status: 'initializing' | 'initialized' | 'failed';
  error?: string;
  /** ms epoch of last status change */
  updatedAt: number;
}

export interface OauthPrompt {
  serverName?: string;
  url: string;
  createdAt: number;
}

/**
 * A snapshot of everything the observability panel shows for one session.
 * Derived purely by folding notifications - see server/session/TurnState.ts.
 */
export interface ObservabilitySnapshot {
  turnStatus: TurnStatus;
  /** Cumulative credits spent this session (sum of all meteringUsage values). */
  creditsSpent: number;
  /** Credits attributed to the most recent completed turn. */
  lastTurnCredits: number;
  /** Latest context-window usage percentage (0-100). */
  contextUsagePercentage: number;
  /** Duration of the most recent completed turn, in ms. */
  lastTurnDurationMs: number;
  /** Wall-clock ms epoch when the current turn started (if running). */
  currentTurnStartedAt?: number;
  subagents: KiroSubagent[];
  pendingStages: unknown[];
  mcpServers: McpServerHealth[];
  availableCommands: KiroCommand[];
  oauthPrompts: OauthPrompt[];
  /** True while a /compact operation is in progress. */
  compacting: boolean;
}

export function emptyObservabilitySnapshot(): ObservabilitySnapshot {
  return {
    turnStatus: 'idle',
    creditsSpent: 0,
    lastTurnCredits: 0,
    contextUsagePercentage: 0,
    lastTurnDurationMs: 0,
    subagents: [],
    pendingStages: [],
    mcpServers: [],
    availableCommands: [],
    oauthPrompts: [],
    compacting: false,
  };
}
