import { create } from 'zustand';
import {
  emptyObservabilitySnapshot,
  stripAttachmentsLine,
  type AgentMode,
  type CasperEvent,
  type MessageAttachment,
  type PromptContentBlock,
  type ModelInfo,
  type ObservabilitySnapshot,
  type ChatDetail,
  type ChatSummary,
  type SubagentSummary,
  type ToolCallProgressUpdate,
  type ToolCallUpdate,
  type TranscriptItem,
  type TranscriptToolCall,
} from '@casper/shared';

import { bumpChatToTop, upsertChat } from './chats.js';
import { classifyTurnFailure } from '../util/turnFailure.js';
import { uuid } from '../util/uuid.js';
import type { ConnStatus } from '../api/SessionSocket.js';

export type ToolCallView = TranscriptToolCall;

interface PendingMessage {
  id: string;
  text: string;
  attachments?: MessageAttachment[];
  /** Exactly what was sent, so a retry re-sends it rather than rebuilding from the text. */
  content: PromptContentBlock[];
  status: 'sending' | 'failed';
  error?: string;
}

export interface ChatNotice {
  title: string;
  fix?: string;
  detail: string;
}

interface CasperState {
  chats: ChatSummary[];
  models: ModelInfo[];
  agents: AgentMode[];
  defaultAgentId: string;

  activeId: string | null;
  chatId: string | null;
  /** Session whose detail is being fetched; null once loadDetail lands. */
  loadingChatId: string | null;
  modes: AgentMode[];
  currentModeId?: string;
  currentModelId?: string;
  items: TranscriptItem[];
  /** Highest event seq already folded into items, so a replayed event can't
   *  append a second copy of the same message or tool call. */
  appliedSeq: number;
  remainingOlder: number;
  observability: ObservabilitySnapshot;
  subagents: SubagentSummary[];
  fsVersion: Record<string, number>;
  watchedPaths: string[];
  streamingText: string;
  streamingThought: string;
  pending: PendingMessage[];
  chatNotice: ChatNotice | null;
  connStatus: ConnStatus;
  createError: string | null;
  reloadingId: string | null;
  previewPath: string | null;

  bumpFsPath: (path: string) => void;
  setWatchedPaths: (paths: string[]) => void;
  setChats: (s: ChatSummary[]) => void;
  setModels: (m: ModelInfo[]) => void;
  setAgents: (a: AgentMode[], defaultAgentId: string) => void;
  setLoadingChat: (id: string | null) => void;
  loadDetail: (d: ChatDetail, opts?: { keepPending?: boolean }) => void;
  prependItems: (older: TranscriptItem[]) => void;
  clearActive: () => void;
  newChatId: () => string;
  applyEvent: (e: CasperEvent) => void;
  addPending: (pending: Omit<PendingMessage, 'status'>) => void;
  markPendingFailed: (id: string, error?: string) => void;
  dismissChatNotice: () => void;
  setChatNotice: (notice: ChatNotice) => void;
  setConnStatus: (status: ConnStatus) => void;
  setCreateError: (message: string | null) => void;
  setReloadingId: (id: string | null) => void;
  openFilePreview: (path: string) => void;
  closeFilePreview: () => void;
  setSubagents: (subagents: SubagentSummary[]) => void;
  markCancelling: () => void;
  setCurrentModel: (modelId: string) => void;
  setCurrentAgent: (modeId: string) => void;
  setCompacting: (compacting: boolean) => void;
  markPendingSending: (id: string) => void;
  renameChatRow: (id: string, title: string) => void;
}

export const useStore = create<CasperState>((set, get) => ({
  chats: [],
  models: [],
  agents: [],
  defaultAgentId: 'kiro_default',
  activeId: null,
  chatId: null,
  loadingChatId: null,
  modes: [],
  items: [],
  appliedSeq: 0,
  remainingOlder: 0,
  observability: emptyObservabilitySnapshot(),
  subagents: [],
  fsVersion: {},
  watchedPaths: [],
  streamingText: '',
  streamingThought: '',
  pending: [],
  chatNotice: null,
  connStatus: 'closed',
  createError: null,
  reloadingId: null,
  previewPath: null,

  setConnStatus: (connStatus) => set({ connStatus }),
  setCreateError: (createError) => set({ createError }),
  setReloadingId: (reloadingId) => set({ reloadingId }),

  openFilePreview: (previewPath) => set({ previewPath }),
  closeFilePreview: () => set({ previewPath: null }),
  setSubagents: (subagents) => set({ subagents }),

  markCancelling: () =>
    set((s) =>
      s.observability.turnStatus === 'running'
        ? { observability: { ...s.observability, turnStatus: 'cancelling' } }
        : {},
    ),

  setCurrentModel: (currentModelId) => set({ currentModelId }),

  setCurrentAgent: (modeId) =>
    set((s) => ({
      currentModeId: modeId,
      chats: s.activeId
        ? s.chats.map((sess) =>
            sess.chatId === s.activeId ? { ...sess, agentId: modeId } : sess,
          )
        : s.chats,
    })),

  setCompacting: (compacting) =>
    set((s) =>
      s.observability.compacting === compacting
        ? {}
        : { observability: { ...s.observability, compacting } },
    ),

  markPendingSending: (id) =>
    set((s) => ({
      pending: s.pending.map((p) =>
        p.id === id ? { ...p, status: 'sending' as const, error: undefined } : p,
      ),
    })),

  renameChatRow: (id, title) =>
    set((s) => ({
      chats: s.chats.map((sess) =>
        sess.chatId === id ? { ...sess, title } : sess,
      ),
    })),

  bumpFsPath: (path) =>
    set((s) => ({ fsVersion: { ...s.fsVersion, [path]: (s.fsVersion[path] ?? 0) + 1 } })),
  setWatchedPaths: (watchedPaths) => set({ watchedPaths }),

  setChats: (chats) => set({ chats }),
  setModels: (models) => set({ models }),
  setAgents: (agents, defaultAgentId) => set({ agents, defaultAgentId }),
  setLoadingChat: (loadingChatId) => set({ loadingChatId }),

  loadDetail: (d, opts) =>
    set((s) => ({
      activeId: d.summary.chatId,
      chatId: d.summary.chatId,
      loadingChatId: null,
      chats: upsertChat(s.chats, d.summary),
      modes: d.modes,
      currentModeId: d.currentModeId,
      currentModelId: d.summary.modelId,
      observability: d.observability,
      items: d.transcript,
      appliedSeq: d.head,
      remainingOlder: Math.max(0, d.transcriptTotal - d.transcript.length),
      streamingText: '',
      streamingThought: '',
      pending: opts?.keepPending ? s.pending : [],
      chatNotice: null,
      subagents: [],
    })),

  prependItems: (older) =>
    set((s) => ({
      items: [...older, ...s.items],
      remainingOlder: Math.max(0, s.remainingOlder - older.length),
    })),

  newChatId: () => {
    const chatId = uuid();
    set({ chatId });
    return chatId;
  },

  clearActive: () =>
    set({
      activeId: null,
      loadingChatId: null,
      modes: [],
      items: [],
      appliedSeq: 0,
      remainingOlder: 0,
      observability: emptyObservabilitySnapshot(),
      streamingText: '',
      streamingThought: '',
      pending: [],
      chatNotice: null,
      currentModeId: undefined,
      currentModelId: undefined,
      previewPath: null,
      subagents: [],
    }),

  dismissChatNotice: () => set({ chatNotice: null }),
  setChatNotice: (chatNotice) => set({ chatNotice }),

  addPending: (pending) =>
    set((s) => ({ pending: [...s.pending, { ...pending, status: 'sending' }] })),
  markPendingFailed: (id, error) =>
    set((s) => ({
      pending: s.pending.map((p) =>
        p.id === id ? { ...p, status: 'failed' as const, error } : p,
      ),
    })),

  applyEvent: (e) => {
    const state = get();
    const p = e.payload;

    // Events are strictly ordered per session; a dropped connection can
    // re-deliver, so drop anything at or below the high-water mark.
    if (e.seq <= state.appliedSeq) return;
    set({ appliedSeq: e.seq });

    switch (p.kind) {
      case 'turn_started': {
        const rawText = p.prompt
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const text = stripAttachmentsLine(rawText);
        // Turns are serialized server-side, so this echoes the oldest pending send.
        const sendingIdx = state.pending.findIndex((pm) => pm.status === 'sending');
        const bumpedAt = new Date(e.ts).toISOString();
        const chats = bumpChatToTop(state.chats, e.chatId, bumpedAt);
        set({
          items: [
            ...state.items,
            {
              type: 'message',
              message: {
                id: `u-${e.seq}`,
                role: 'user',
                text,
                timestamp: e.ts,
                attachments: p.attachments,
              },
            },
          ],
          pending:
            sendingIdx === -1
              ? state.pending
              : state.pending.filter((_, i) => i !== sendingIdx),
          chats,
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
          const toolName = (tc as { _meta?: { kiro?: { toolName?: string } } })._meta?.kiro
            ?.toolName;
          set({
            items: [
              ...commitStreaming(state, `s-${e.seq}`, e.ts),
              {
                type: 'tool_call',
                tool: {
                  id: tc.toolCallId,
                  name: toolName,
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
          chatNotice: null,
          streamingText: '',
          streamingThought: '',
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
      }

      case 'turn_error': {
        const failure = classifyTurnFailure(p.message);
        set({
          items: [
            ...commitStreaming(state, `s-${e.seq}`, e.ts),
            { type: 'turn_error', id: `err-${e.seq}`, message: p.message, timestamp: e.ts },
          ],
          chatNotice: failure.sessionWide
            ? { title: failure.title, fix: failure.fix, detail: p.message }
            : state.chatNotice,
          streamingText: '',
          streamingThought: '',
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
      }

      case 'subagents_changed':
        set({ subagents: p.subagents });
        break;

      case 'metadata':
        set({
          observability: {
            ...state.observability,
            contextUsagePercentage:
              p.params.contextUsagePercentage ?? state.observability.contextUsagePercentage,
          },
        });
        break;

      case 'compaction': {
        const done = p.params.status.type !== 'started';
        const summary = p.params.summary ?? '';
        set({
          observability: { ...state.observability, compacting: !done },
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

      case 'process_exited':
        // Also clears compacting: a dead process never sends the completion that
        // normally would, and while set it disables the composer.
        set({
          observability: { ...state.observability, turnStatus: 'idle', compacting: false },
        });
        break;
    }
  },
}));

/* baseId must be unique per commit (seq-derived) so React keys stay stable and
   never reuse a DOM node from a prior commit. */
function commitStreaming(
  state: CasperState,
  baseId: string,
  ts = Date.now(),
): TranscriptItem[] {
  const next = [...state.items];
  if (state.streamingThought.trim()) {
    next.push({
      type: 'message',
      // Trimmed: this renders pre-wrap, so a late chunk would otherwise open
      // the next commit with blank lines.
      message: {
        id: `t-${baseId}`,
        role: 'thinking',
        text: state.streamingThought.trim(),
        timestamp: ts,
      },
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
