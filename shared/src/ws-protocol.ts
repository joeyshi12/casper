/**
 * WebSocket protocol: the resumable streaming channel between browser and server.
 *
 * Every event carries a strictly increasing per-session `seq`. The client remembers the
 * last one it applied and sends that cursor on reconnect; the server replays everything
 * after it, or answers `resync` if the cursor is older than the buffer.
 */

import type {
  KiroCompactionStatusParams,
  KiroMetadataParams,
  PromptContentBlock,
  SessionUpdate,
  StopReason,
} from './acp.js';
import type { MessageAttachment, SubagentSummary, TurnStats } from './rest-dto.js';

/** A streamed session/update (agent chunk, tool call, etc). */
export interface SessionUpdateEvent {
  kind: 'session_update';
  update: SessionUpdate;
}

export interface MetadataEvent {
  kind: 'metadata';
  params: KiroMetadataParams;
}

export interface CompactionEvent {
  kind: 'compaction';
  params: KiroCompactionStatusParams;
}

/**
 * The chat's subagents changed. Carries the full list rather than a delta: there are at
 * most a handful per chat, so a delta would need its own merge logic for no real saving.
 */
export interface SubagentsChangedEvent {
  kind: 'subagents_changed';
  subagents: SubagentSummary[];
}

export interface TurnStartedEvent {
  kind: 'turn_started';
  prompt: PromptContentBlock[];
  attachments?: MessageAttachment[];
}

export interface TurnEndedEvent {
  kind: 'turn_ended';
  stopReason: StopReason;
  /** What the turn took, when kiro reported it. */
  stats?: TurnStats;
}

/** A message sent into the running turn reached the model. `clientId` is the sender's
 *  own id for it, so its tab can drop the copy it showed while waiting. */
export interface SteerInjectedEvent {
  kind: 'steer_injected';
  text: string;
  clientId?: string;
}

/** A message sent into the running turn did not reach the model before the turn ended. */
export interface SteerDroppedEvent {
  kind: 'steer_dropped';
  text: string;
  clientId?: string;
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

/** kiro named the session. */
export interface TitleChangedEvent {
  kind: 'title_changed';
  title: string;
}

/** kiro reported the session's model and effort, after either changed. `effortLevel` is
 *  null for a model without effort levels. */
export interface SettingsChangedEvent {
  kind: 'settings_changed';
  modelId?: string;
  effortLevel: string | null;
}

/** kiro's id for the prompt the running turn started with. */
export interface PromptIdEvent {
  kind: 'prompt_id';
  messageId: string;
}

/** The chat's history was cut (a rewind, or a failed turn removed before its retry), so
 *  clients refetch it. */
export interface HistoryReplacedEvent {
  kind: 'history_replaced';
}

export type CasperEventPayload =
  | SessionUpdateEvent
  | TitleChangedEvent
  | SettingsChangedEvent
  | PromptIdEvent
  | HistoryReplacedEvent
  | SteerInjectedEvent
  | SteerDroppedEvent
  | MetadataEvent
  | CompactionEvent
  | SubagentsChangedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | TurnErrorEvent
  | ProcessExitedEvent;

export interface CasperEvent {
  seq: number;
  ts: number;
  chatId: string;
  payload: CasperEventPayload;
}

export interface ClientPrompt {
  type: 'prompt';
  attachments?: MessageAttachment[];
  content: PromptContentBlock[];
  /** Sent again after its turn failed. A failed turn kiro kept nothing of is first removed,
   *  so the model does not read the prompt twice. */
  retry?: boolean;
}

/** A message for the turn that is running. */
export interface ClientSteer {
  type: 'steer';
  text: string;
  clientId?: string;
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

export interface ClientSetEffort {
  type: 'set_effort';
  effortLevel: string;
}

export interface ClientExecCommand {
  type: 'exec_command';
  command: string;
}

export interface ClientPing {
  type: 'ping';
}

/** The directories the file panel is showing, relative to the session's cwd.
 *  Replaces the previous set, so closing a folder stops its watch. */
export interface ClientWatchPaths {
  type: 'watch_paths';
  paths: string[];
}

export type ClientMessage =
  | ClientPrompt
  | ClientSteer
  | ClientCancel
  | ClientSetMode
  | ClientSetModel
  | ClientSetEffort
  | ClientExecCommand
  | ClientPing
  | ClientWatchPaths;

export interface ServerEvent {
  type: 'event';
  event: CasperEvent;
}

export interface ServerReplayComplete {
  type: 'replay_complete';
  head: number;
}

/** Client's cursor is older than the buffer tail - refetch full transcript. */
export interface ServerResync {
  type: 'resync';
  reason: string;
}

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

/** A watched directory changed on disk. Connection-scoped, not a session event:
 *  it depends on what this client is looking at, not on replayable history. */
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
