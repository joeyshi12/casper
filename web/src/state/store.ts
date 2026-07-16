import { create } from 'zustand';
import {
  emptyObservabilitySnapshot,
  imageAttachmentPaths,
  stripAttachmentsLine,
  type AgentMode,
  type CasperEvent,
  type ModelInfo,
  type ObservabilitySnapshot,
  type SessionDetail,
  type SessionSummary,
  type ToolCallProgressUpdate,
  type ToolCallUpdate,
  type TranscriptItem,
  type TranscriptToolCall,
} from '@casper/shared';

/** A rendered tool call in the transcript (shared shape). */
export type ToolCallView = TranscriptToolCall;

export type { TranscriptItem };

/** A locally-sent user message awaiting server acknowledgement. */
export interface PendingMessage {
  id: string;
  text: string;
  status: 'sending' | 'failed';
}

/** A transient notification shown in the corner (auto-dismissed). */
export interface Toast {
  id: string;
  message: string;
  kind: 'error' | 'info';
}

interface CasperState {
  // Session list
  sessions: SessionSummary[];
  models: ModelInfo[];
  agents: AgentMode[]; // global agent list (from /api/agents) - always populated

  // Active session
  activeId: string | null;
  modes: AgentMode[];
  currentModeId?: string;
  currentModelId?: string;
  items: TranscriptItem[];
  observability: ObservabilitySnapshot;
  streamingText: string; // in-flight assistant chunk not yet committed
  streamingThought: string; // in-flight reasoning chunk not yet committed
  pending: PendingMessage[]; // user messages sent locally, awaiting server echo
  toasts: Toast[]; // transient corner notifications

  // actions
  setSessions: (s: SessionSummary[]) => void;
  setModels: (m: ModelInfo[]) => void;
  setAgents: (a: AgentMode[]) => void;
  loadDetail: (d: SessionDetail) => void;
  clearActive: () => void;
  applyEvent: (e: CasperEvent) => void;
  addPending: (id: string, text: string) => void;
  markPendingFailed: (id: string) => void;
  removePending: (id: string) => void;
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
}

export const useStore = create<CasperState>((set, get) => ({
  sessions: [],
  models: [],
  agents: [],
  activeId: null,
  modes: [],
  items: [],
  observability: emptyObservabilitySnapshot(),
  streamingText: '',
  streamingThought: '',
  pending: [],
  toasts: [],

  setSessions: (sessions) => set({ sessions }),
  setModels: (models) => set({ models }),
  setAgents: (agents) => set({ agents }),

  loadDetail: (d) =>
    set({
      activeId: d.summary.sessionId,
      modes: d.modes,
      currentModeId: d.currentModeId,
      currentModelId: d.summary.modelId,
      observability: d.observability,
      items: d.transcript,
      streamingText: '',
      streamingThought: '',
      pending: [],
    }),

  clearActive: () =>
    set({
      activeId: null,
      modes: [],
      items: [],
      observability: emptyObservabilitySnapshot(),
      streamingText: '',
      streamingThought: '',
      pending: [],
    }),

  addPending: (id, text) =>
    set((s) => ({ pending: [...s.pending, { id, text, status: 'sending' }] })),
  markPendingFailed: (id) =>
    set((s) => ({
      pending: s.pending.map((p) =>
        p.id === id ? { ...p, status: 'failed' as const } : p,
      ),
    })),
  removePending: (id) =>
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),

  pushToast: (message, kind = 'error') =>
    set((s) => ({
      toasts: [...s.toasts, { id: `t-${Date.now()}-${s.toasts.length}`, message, kind }],
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  applyEvent: (e) => {
    const state = get();
    const p = e.payload;

    switch (p.kind) {
      case 'turn_started': {
        const rawText = p.prompt
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const text = stripAttachmentsLine(rawText);
        const imagePaths = imageAttachmentPaths(rawText);
        // Drop the oldest optimistic bubble still marked 'sending' - turns are
        // serialized server-side, so this turn_started is that send's echo.
        const sendingIdx = state.pending.findIndex((pm) => pm.status === 'sending');
        set({
          items: [
            ...state.items,
            {
              type: 'message',
              message: { id: `u-${e.seq}`, role: 'user', text, timestamp: e.ts, imagePaths },
            },
          ],
          pending:
            sendingIdx === -1
              ? state.pending
              : state.pending.filter((_, i) => i !== sendingIdx),
          streamingText: '',
          observability: { ...state.observability, turnStatus: 'running' },
        });
        break;
      }

      case 'session_update': {
        const u = p.update;
        if (u.sessionUpdate === 'agent_message_chunk') {
          const chunk = (u as { content?: { text?: string } }).content?.text ?? '';
          set({ streamingText: state.streamingText + chunk });
        } else if (u.sessionUpdate === 'agent_thought_chunk') {
          const chunk = (u as { content?: { text?: string } }).content?.text ?? '';
          set({ streamingThought: state.streamingThought + chunk });
        } else if (u.sessionUpdate === 'tool_call') {
          const tc = u as ToolCallUpdate;
          set({
            items: [
              ...commitStreaming(state, `s-${e.seq}`, e.ts),
              {
                type: 'tool_call',
                tool: {
                  id: tc.toolCallId,
                  title: tc.title ?? tc.toolCallId,
                  kind: tc.kind,
                  status: tc.status ?? 'pending',
                  input: tc.rawInput,
                  content: tc.content ?? [],
                },
              },
            ],
            streamingText: '',
            streamingThought: '',
          });
        } else if (u.sessionUpdate === 'tool_call_update') {
          const tu = u as ToolCallProgressUpdate;
          set({
            items: state.items.map((it) =>
              it.type === 'tool_call' && it.tool.id === tu.toolCallId
                ? {
                    type: 'tool_call',
                    tool: {
                      ...it.tool,
                      status: tu.status ?? it.tool.status,
                      output: tu.rawOutput ?? it.tool.output,
                      content: tu.content ?? it.tool.content,
                    },
                  }
                : it,
            ),
          });
        }
        break;
      }

      case 'turn_ended': {
        set({
          items: commitStreaming(state, `s-${e.seq}`, e.ts),
          streamingText: '',
          streamingThought: '',
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
      }

      case 'turn_error': {
        set({
          items: [
            ...commitStreaming(state, `s-${e.seq}`, e.ts),
            {
              type: 'message',
              message: {
                id: `err-${e.seq}`,
                role: 'assistant',
                text: `⚠️ ${p.message}`,
                timestamp: e.ts,
              },
            },
          ],
          streamingText: '',
          streamingThought: '',
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
      }

      case 'metadata': {
        const turnCredits = (p.params.meteringUsage ?? []).reduce(
          (s, m) => s + m.value,
          0,
        );
        set({
          observability: {
            ...state.observability,
            contextUsagePercentage:
              p.params.contextUsagePercentage ??
              state.observability.contextUsagePercentage,
            creditsSpent:
              turnCredits > 0
                ? state.observability.creditsSpent + turnCredits
                : state.observability.creditsSpent,
            lastTurnCredits:
              turnCredits > 0 ? turnCredits : state.observability.lastTurnCredits,
            lastTurnDurationMs:
              p.params.turnDurationMs ?? state.observability.lastTurnDurationMs,
          },
        });
        break;
      }

      case 'subagent_update':
        set({
          observability: {
            ...state.observability,
            subagents: p.params.subagents,
            pendingStages: p.params.pendingStages,
          },
        });
        break;

      case 'mcp_health': {
        const next = state.observability.mcpServers.filter(
          (m) => m.serverName !== p.params.serverName,
        );
        next.push({
          serverName: p.params.serverName,
          status: p.ok ? 'initialized' : 'failed',
          error: p.params.error,
          updatedAt: e.ts,
        });
        set({ observability: { ...state.observability, mcpServers: next } });
        break;
      }

      case 'commands_available':
        set({
          observability: {
            ...state.observability,
            availableCommands: p.params.commands,
          },
        });
        break;

      case 'compaction': {
        const done = p.params.status.type !== 'started';
        const summary = p.params.summary ?? '';
        set({
          observability: { ...state.observability, compacting: !done },
          // On completion, drop a durable divider into the transcript so the
          // user sees what kiro condensed the history into (and why context
          // dropped). Reloads reconstruct the same item from the .jsonl.
          items:
            done && summary.trim()
              ? [
                  ...state.items,
                  { type: 'compaction', id: `c-${e.seq}`, summary, timestamp: e.ts },
                ]
              : state.items,
        });
        break;
      }

      case 'oauth_request':
        set({
          observability: {
            ...state.observability,
            oauthPrompts: [
              ...state.observability.oauthPrompts,
              { serverName: p.params.serverName, url: p.params.url, createdAt: e.ts },
            ],
          },
        });
        break;

      case 'process_exited':
        set({
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
    }
  },
}));

/**
 * Commit any in-flight streaming reasoning + assistant text as transcript
 * entries. `baseId` must be unique per commit (seq-derived) so React keys stay
 * stable and it never reuses a DOM node from a prior commit.
 */
function commitStreaming(
  state: CasperState,
  baseId: string,
  ts = Date.now(),
): TranscriptItem[] {
  const next = [...state.items];
  if (state.streamingThought.trim()) {
    next.push({
      type: 'message',
      message: { id: `t-${baseId}`, role: 'thinking', text: state.streamingThought, timestamp: ts },
    });
  }
  if (state.streamingText.trim()) {
    next.push({
      type: 'message',
      message: { id: `a-${baseId}`, role: 'assistant', text: state.streamingText, timestamp: ts },
    });
  }
  return next;
}
