// ACP (Agent Client Protocol) types for kiro-cli, transported as
// newline-delimited JSON-RPC 2.0 over stdio. See https://kiro.dev/docs/cli/acp/

// JSON-RPC 2.0 envelope

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

// initialize

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo?: { name: string; version: string };
}

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  authMethods?: unknown[];
  agentInfo: { name: string; title?: string; version: string };
}

// session/new, session/load

export interface McpServerConfig {
  // kiro spawns MCP servers itself from its config; Casper passes [].
  [key: string]: unknown;
}

export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServerConfig[];
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

export interface SessionNewResult {
  sessionId: string;
  modes: SessionModes;
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
}

export type SessionLoadResult = SessionNewResult;

// session/set_mode, session/set_model

export interface SessionSetModeParams {
  sessionId: string;
  modeId: string;
}

export interface SessionSetModelParams {
  sessionId: string;
  modelId: string;
}

// session/prompt

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

export interface SessionCancelParams {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// session/update notifications (streamed during a prompt turn)
// ---------------------------------------------------------------------------

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

/** ACP-standard tool_call update - an MCP/agent tool invocation. */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContent[];
}

/** Progress/result update for a previously-announced tool call. */
export interface ToolCallProgressUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  rawOutput?: unknown;
}

export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries?: unknown[];
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallProgressUpdate
  | PlanUpdate
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// _kiro.dev/* extension notifications (observability + commands)
// ---------------------------------------------------------------------------

export interface MeteringUsage {
  value: number;
  unit: string; // "credit"
  unitPlural: string; // "credits"
}

export interface KiroMetadataParams {
  sessionId: string;
  contextUsagePercentage?: number;
  meteringUsage?: MeteringUsage[];
  turnDurationMs?: number;
}

export interface KiroSubagent {
  id?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export interface KiroSubagentListParams {
  sessionId?: string;
  subagents: KiroSubagent[];
  pendingStages: unknown[];
}

export interface KiroMcpServerParams {
  sessionId: string;
  serverName: string;
  error?: string;
}

export interface KiroCommand {
  name: string;
  description?: string;
  meta?: {
    optionsMethod?: string;
    inputType?: string;
    local?: boolean;
    hint?: string;
    subcommands?: string[];
    subcommandHints?: Record<string, string>;
    [key: string]: unknown;
  };
}

export interface KiroCommandsAvailableParams {
  sessionId: string;
  commands: KiroCommand[];
}

/** Progress of a /compact operation (`_kiro.dev/compaction/status`). */
export interface KiroCompactionStatusParams {
  sessionId: string;
  status: { type: 'started' | 'completed' | 'failed' | string };
  /** The conversation summary once compaction completes (null while running). */
  summary: string | null;
}

export interface KiroOauthRequestParams {
  sessionId: string;
  serverName?: string;
  url: string;
}

/**
 * `_kiro.dev/commands/execute` params. The command is a structured object -
 * the name has no leading slash (advertised "/compact", executed "compact")
 * and args is an object (empty for no-arg commands like compact/context).
 */
export interface KiroCommandsExecuteParams {
  sessionId: string;
  command: { command: string; args: Record<string, unknown> };
}

// Well-known method names, so string literals never drift.
export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetModel: 'session/set_model',
  sessionUpdate: 'session/update',
  commandsExecute: '_kiro.dev/commands/execute',
  commandsOptions: '_kiro.dev/commands/options',
} as const;

export const KIRO_NOTIFICATIONS = {
  metadata: '_kiro.dev/metadata',
  subagentListUpdate: '_kiro.dev/subagent/list_update',
  mcpServerInitialized: '_kiro.dev/mcp/server_initialized',
  mcpServerInitFailure: '_kiro.dev/mcp/server_init_failure',
  commandsAvailable: '_kiro.dev/commands/available',
  mcpOauthRequest: '_kiro.dev/mcp/oauth_request',
  compactionStatus: '_kiro.dev/compaction/status',
} as const;
