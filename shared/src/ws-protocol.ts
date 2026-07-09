/**
 * WebSocket protocol - the resumable streaming channel between the browser
 * and the Casper server.
 *
 * Core invariant: every server-side event carries a strictly increasing
 * per-session `seq`. The client remembers the last `seq` it applied; on
 * reconnect it sends that cursor and the server replays everything after it
 * (or tells the client to `resync` if the cursor is older than the buffer).
 * This is what lets a long agent run survive a disconnect or tab close.
 */

import type {
  KiroCommandsAvailableParams,
  KiroMcpServerParams,
  KiroMetadataParams,
  KiroOauthRequestParams,
  KiroSubagentListParams,
  PromptContentBlock,
  SessionUpdate,
  StopReason,
} from './acp.js';

// ---------------------------------------------------------------------------
// Buffered events - the payloads stored in the EventStore and replayed
// ---------------------------------------------------------------------------

/** A streamed session/update (agent chunk, tool call, etc). */
export interface SessionUpdateEvent {
  kind: 'session_update';
  update: SessionUpdate;
}

export interface MetadataEvent {
  kind: 'metadata';
  params: KiroMetadataParams;
}

export interface SubagentEvent {
  kind: 'subagent_update';
  params: KiroSubagentListParams;
}

export interface McpHealthEvent {
  kind: 'mcp_health';
  params: KiroMcpServerParams;
  ok: boolean;
}

export interface CommandsAvailableEvent {
  kind: 'commands_available';
  params: KiroCommandsAvailableParams;
}

export interface OauthRequestEvent {
  kind: 'oauth_request';
  params: KiroOauthRequestParams;
}

// Synthetic lifecycle events injected by the server.
export interface TurnStartedEvent {
  kind: 'turn_started';
  /** echo of the user's prompt so the transcript shows it immediately */
  prompt: PromptContentBlock[];
}

export interface TurnEndedEvent {
  kind: 'turn_ended';
  stopReason: StopReason;
}

export interface TurnErrorEvent {
  kind: 'turn_error';
  message: string;
}

export interface ProcessExitedEvent {
  kind: 'process_exited';
  code: number | null;
  signal: string | null;
}

export type CasperEventPayload =
  | SessionUpdateEvent
  | MetadataEvent
  | SubagentEvent
  | McpHealthEvent
  | CommandsAvailableEvent
  | OauthRequestEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | TurnErrorEvent
  | ProcessExitedEvent;

/** A seq-numbered event as stored in the EventStore and sent to clients. */
export interface CasperEvent {
  seq: number;
  ts: number;
  sessionId: string;
  payload: CasperEventPayload;
}

// ---------------------------------------------------------------------------
// Client -> Server messages
// ---------------------------------------------------------------------------

export interface ClientHello {
  type: 'hello';
  sessionId: string;
  /** Last applied seq. 0 (or omitted) = fresh, replay from start of buffer. */
  cursor?: number;
}

export interface ClientPrompt {
  type: 'prompt';
  content: PromptContentBlock[];
}

export interface ClientCancel {
  type: 'cancel';
}

export interface ClientSetMode {
  type: 'set_mode';
  modeId: string;
}

export interface ClientSetModel {
  type: 'set_model';
  modelId: string;
}

export interface ClientExecCommand {
  type: 'exec_command';
  command: string;
  args?: string;
}

export interface ClientPing {
  type: 'ping';
}

export type ClientMessage =
  | ClientHello
  | ClientPrompt
  | ClientCancel
  | ClientSetMode
  | ClientSetModel
  | ClientExecCommand
  | ClientPing;

// ---------------------------------------------------------------------------
// Server -> Client messages
// ---------------------------------------------------------------------------

/** A buffered/live event delivered to the client. */
export interface ServerEvent {
  type: 'event';
  event: CasperEvent;
}

/** Sent after the initial replay is done; client is now caught up. */
export interface ServerReplayComplete {
  type: 'replay_complete';
  head: number;
}

/** Client's cursor is older than the buffer tail - refetch full transcript. */
export interface ServerResync {
  type: 'resync';
  reason: string;
}

/** Acknowledge a control action (set_mode/set_model/exec). */
export interface ServerAck {
  type: 'ack';
  action: string;
  ok: boolean;
  error?: string;
}

export interface ServerPong {
  type: 'pong';
}

export interface ServerError {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | ServerEvent
  | ServerReplayComplete
  | ServerResync
  | ServerAck
  | ServerPong
  | ServerError;
