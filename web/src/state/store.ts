import { create } from 'zustand';
import {
  emptyObservabilitySnapshot,
  type AgentMode,
  type CasperEvent,
  type ModelInfo,
  type ObservabilitySnapshot,
  type SessionDetail,
  type SessionSummary,
  type ToolCallProgressUpdate,
  type ToolCallUpdate,
  type TranscriptMessage,
} from '@casper/shared';
import type { ConnStatus } from '../api/SessionSocket.js';

/** A rendered tool call in the transcript. */
export interface ToolCallView {
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
  | { type: 'tool_call'; tool: ToolCallView };

interface CasperState {
  // Session list
  sessions: SessionSummary[];
  models: ModelInfo[];
  agents: AgentMode[]; // global agent list (from /api/agents) - always populated
  connStatus: ConnStatus;

  // Active session
  activeId: string | null;
  modes: AgentMode[];
  currentModeId?: string;
  currentModelId?: string;
  items: TranscriptItem[];
  observability: ObservabilitySnapshot;
  streamingText: string; // in-flight assistant chunk not yet committed

  // actions
  setSessions: (s: SessionSummary[]) => void;
  setModels: (m: ModelInfo[]) => void;
  setAgents: (a: AgentMode[]) => void;
  setConnStatus: (s: ConnStatus) => void;
  loadDetail: (d: SessionDetail) => void;
  clearActive: () => void;
  applyEvent: (e: CasperEvent) => void;
}

export const useStore = create<CasperState>((set, get) => ({
  sessions: [],
  models: [],
  agents: [],
  connStatus: 'closed',
  activeId: null,
  modes: [],
  items: [],
  observability: emptyObservabilitySnapshot(),
  streamingText: '',

  setSessions: (sessions) => set({ sessions }),
  setModels: (models) => set({ models }),
  setAgents: (agents) => set({ agents }),
  setConnStatus: (connStatus) => set({ connStatus }),

  loadDetail: (d) =>
    set({
      activeId: d.summary.sessionId,
      modes: d.modes,
      currentModeId: d.currentModeId,
      currentModelId: d.summary.modelId,
      observability: d.observability,
      items: d.transcript.map((message) => ({ type: 'message', message })),
      streamingText: '',
    }),

  clearActive: () =>
    set({
      activeId: null,
      modes: [],
      items: [],
      observability: emptyObservabilitySnapshot(),
      streamingText: '',
    }),

  applyEvent: (e) => {
    const state = get();
    const p = e.payload;

    switch (p.kind) {
      case 'turn_started': {
        const text = p.prompt
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        set({
          items: [
            ...state.items,
            {
              type: 'message',
              message: { id: `u-${e.seq}`, role: 'user', text, timestamp: e.ts },
            },
          ],
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
        } else if (u.sessionUpdate === 'tool_call') {
          const tc = u as ToolCallUpdate;
          set({
            items: [
              ...commitStreaming(state),
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
          items: commitStreaming(state, `a-${e.seq}`, e.ts),
          streamingText: '',
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
      }

      case 'turn_error': {
        set({
          items: [
            ...commitStreaming(state, `a-${e.seq}`, e.ts),
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

/** Commit any in-flight streaming text as an assistant message. */
function commitStreaming(
  state: CasperState,
  id = `a-stream`,
  ts = Date.now(),
): TranscriptItem[] {
  if (!state.streamingText.trim()) return state.items;
  return [
    ...state.items,
    {
      type: 'message',
      message: { id, role: 'assistant', text: state.streamingText, timestamp: ts },
    },
  ];
}
