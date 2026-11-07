// ACP (Agent Client Protocol) types for kiro-cli's V3 engine (`kiro-cli acp
// --agent-engine v3`), transported as newline-delimited JSON-RPC 2.0 over stdio.
// See https://kiro.dev/docs/cli/v3/acp-migration/

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isJsonRpcResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return 'id' in m && m.id !== undefined && ('result' in m || 'error' in m);
}

export function isJsonRpcError(m: JsonRpcResponse): m is JsonRpcError {
  return 'error' in m;
}

export function isJsonRpcNotification(
  m: JsonRpcMessage,
): m is JsonRpcNotification {
  return !('id' in m) && 'method' in m;
}

/** The session inputs kiro reads from `_meta.kiro` on session/new and session/load.
 *  On load, kiro applies `modelId` but keeps the session's own mode. */
export interface KiroSessionInputs {
  modeId?: string;
  modelId?: string;
}

// kiro spawns MCP servers itself from its config, so Casper always passes [].
export interface SessionNewParams {
  cwd: string;
  mcpServers: never[];
  _meta?: { kiro: KiroSessionInputs };
}

/** An ACP "mode", which maps to a selectable kiro-cli agent. */
export interface AgentMode {
  id: string;
  name: string;
  description?: string;
  _meta?: {
    welcomeMessage?: string;
    [key: string]: unknown;
  };
}

export interface SessionModes {
  currentModeId: string;
  availableModes: AgentMode[];
}

/** One advertised session setting, such as the model (`id: 'model'`). */
export interface SessionConfigOption {
  id: string;
  currentValue?: string;
  [key: string]: unknown;
}

export interface SessionNewResult {
  sessionId: string;
  modes: SessionModes;
  configOptions?: SessionConfigOption[];
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: never[];
  _meta?: { kiro: KiroSessionInputs };
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  /** base64-encoded image data */
  data: string;
  mimeType: string;
}

export type PromptContentBlock = TextContentBlock | ImageContentBlock;

export interface SessionPromptParams {
  sessionId: string;
  prompt: PromptContentBlock[];
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'cancelled'
  | 'refusal'
  | string;

export interface SessionPromptResult {
  stopReason: StopReason;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: PromptContentBlock;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: PromptContentBlock;
}

export type ToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | string;

export interface ToolCallContent {
  type: string;
  [key: string]: unknown;
}

/** What kiro attaches under `_meta.kiro` on a session update. */
export interface KiroUpdateMeta {
  /** 'agent-subtask' on the tool call that starts a subagent. */
  kind?: string;
  /** On the call that starts a subagent, that subagent's id. On any other update, the
   *  subagent the update came from: kiro sends a subagent's own updates on its parent's
   *  session. */
  agentSubtaskId?: string;
  /** The server of an MCP tool call. */
  serverName?: string;
  /** Set on updates kiro replays during session/load. */
  replay?: boolean;
  [key: string]: unknown;
}

/** ACP-standard tool_call update - an MCP/agent tool invocation. */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContent[];
  _meta?: { kiro?: KiroUpdateMeta };
}

/** Progress/result update for a previously-announced tool call. */
export interface ToolCallProgressUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  rawOutput?: unknown;
  _meta?: { kiro?: KiroUpdateMeta };
}

/** kiro's session-level events, told apart by `_meta.kiro.kind`: `context_usage`
 *  carries `usagePercentage`, and `summarization_started`, `summarization_completed`
 *  (with `conversationSummary`) and `summarization_failed` report a compaction. */
export interface SessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string;
  _meta?: {
    kiro?: {
      kind?: string;
      usagePercentage?: number;
      conversationSummary?: string;
      [key: string]: unknown;
    };
  };
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallProgressUpdate
  | SessionInfoUpdate
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

/** The name Casper gives the tool call that starts a subagent. */
export const SUBAGENT_TOOL = 'invoke_sub_agent';

/**
 * The tool name Casper uses for a kiro tool call, live or read back from kiro's files.
 * kiro sends no stable name for its built-in tools, so those stay unnamed and are told
 * apart by kind and input. An MCP tool is named `server/tool`; kiro titles it
 * `@server/tool`.
 */
export function kiroToolName(call: { title?: string; _meta?: { kiro?: KiroUpdateMeta } }): string | undefined {
  const meta = call._meta?.kiro;
  if (meta?.kind === 'agent-subtask') return SUBAGENT_TOOL;
  const server = meta?.serverName;
  if (!server) return undefined;
  const title = call.title ?? '';
  const prefix = `@${server}/`;
  return `${server}/${title.startsWith(prefix) ? title.slice(prefix.length) : title}`;
}

/** One choice kiro offers on session/request_permission. */
export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string };
  options?: PermissionOption[];
}

// The shapes Casper records for context usage and compaction. kiro reports both as
// `session_info_update`; SessionManager maps them into these.

export interface KiroMetadataParams {
  sessionId: string;
  contextUsagePercentage?: number;
}

export interface KiroCompactionStatusParams {
  sessionId: string;
  status: { type: 'started' | 'completed' | 'failed' | string };
  /** The conversation summary once compaction completes (null while running). */
  summary: string | null;
}

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  compact: '_kiro/session/compact',
} as const;

/** kiro's notice that a requested agent could not be used, so the session fell back to
 *  another one. */
export const KIRO_AGENT_NOT_FOUND = '_kiro/customAgent/not_found';
