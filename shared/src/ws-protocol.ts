/**
 * WebSocket protocol - the resumable streaming channel between browser and server.
 *
 * Every event carries a strictly increasing per-session `seq`. The client remembers the
 * last one it applied and sends that cursor on reconnect; the server replays everything
 * after it, or answers `resync` if the cursor is older than the buffer. This is what lets
 * a long agent run survive a disconnect.
 */

import type {
  KiroCompactionStatusParams,
  KiroMetadataParams,
  PromptContentBlock,
  SessionUpdate,
  StopReason,
} from './acp.js';
import type { MessageAttachment } from './rest-dto.js';

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

/** Progress of a /compact operation, so the client can show a compacting state. */
export interface CompactionEvent {
  kind: 'compaction';
  params: KiroCompactionStatusParams;
}

// Synthetic lifecycle events injected by the server.
export interface TurnStartedEvent {
  kind: 'turn_started';
  /** echo of the user's prompt so the transcript shows it immediately */
  prompt: PromptContentBlock[];
  /** What was attached, so the bubble can show it without reading the prompt text. */
  attachments?: MessageAttachment[];
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
  | CompactionEvent
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

export interface ClientPrompt {
  type: 'prompt';
  /** See PromptRequest.attachments. */
  attachments?: MessageAttachment[];
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
}

export interface ClientPing {
  type: 'ping';
}

/**
 * The directories the file panel is currently showing, relative to the session's
 * working directory. Replaces the previous set, so closing a folder stops its watch.
 */
export interface ClientWatchPaths {
  type: 'watch_paths';
  paths: string[];
}

export type ClientMessage =
  | ClientPrompt
  | ClientCancel
  | ClientSetMode
  | ClientSetModel
  | ClientExecCommand
  | ClientPing
  | ClientWatchPaths;

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

/**
 * A watched directory changed on disk. Connection-scoped rather than a session event:
 * it depends on what this client is looking at, so it is not part of the replayable
 * history.
 */
export interface ServerFsChanged {
  type: 'fs_changed';
  path: string;
}

export type ServerMessage =
  | ServerEvent
  | ServerFsChanged
  | ServerReplayComplete
  | ServerResync
  | ServerAck
  | ServerPong
  | ServerError;
