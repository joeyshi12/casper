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
  type ToolCallProgressUpdate,
  type ToolCallUpdate,
  type TranscriptItem,
  type TranscriptToolCall,
} from '@casper/shared';

import { bumpChatToTop, upsertChat } from './chats.js';
import { classifyTurnFailure } from '../util/turnFailure.js';
import type { ConnStatus } from '../api/SessionSocket.js';

/** A rendered tool call in the transcript (shared shape). */
export type ToolCallView = TranscriptToolCall;

/** A locally-sent user message awaiting server acknowledgement. */
interface PendingMessage {
  id: string;
  text: string;
  /** Shown on the optimistic bubble, so an attachment is visible before the server echo. */
  attachments?: MessageAttachment[];
  /** Exactly what was sent, so a retry re-sends it rather than rebuilding from the text. */
  content: PromptContentBlock[];
  status: 'sending' | 'failed';
  /** Why the send failed, when the server or socket told us. */
  error?: string;
}

/** A condition that outlives a single turn (bad credentials, missing binary), so
 *  it stays pinned above the composer until it's resolved or dismissed. */
export interface ChatNotice {
  title: string;
  fix?: string;
  /** The raw server message, kept so the notice can offer the real text. */
  detail: string;
}

interface CasperState {
  // Session list
  chats: ChatSummary[];
  models: ModelInfo[];
  agents: AgentMode[]; // global agent list (from /api/agents) - always populated
  defaultAgentId: string; // server-configured default (DEFAULT_AGENT) for new chats

  // Active session
  activeId: string | null;
  /** The chat that owns the uploads directory; minted for a draft, then adopted. */
  chatId: string | null;
  /** Session whose detail is currently being fetched (opening/switching), so
   *  the pane can show a loading state instead of the previous session's stale
   *  content while a slow transcript hydrates. Null once loadDetail lands. */
  loadingChatId: string | null;
  modes: AgentMode[];
  currentModeId?: string;
  currentModelId?: string;
  items: TranscriptItem[];
  /** Highest event seq already folded into items, so a replayed or duplicated
   *  event can't append a second copy of the same message or tool call. */
  appliedSeq: number;
  /** Count of older transcript items not yet loaded (before the loaded window),
   *  for lazy load-on-scroll-up. More items exist while this is > 0. */
  remainingOlder: number;
  observability: ObservabilitySnapshot;
  /** Bumped per directory when the server reports it changed, so open folders reload. */
  fsVersion: Record<string, number>;
  /** Directories the file panel is showing, sent to the server as its watch set. */
  watchedPaths: string[];
  streamingText: string; // in-flight assistant chunk not yet committed
  streamingThought: string; // in-flight reasoning chunk not yet committed
  pending: PendingMessage[]; // user messages sent locally, awaiting server echo
  chatNotice: ChatNotice | null;
  /** Socket state for the active session, so the pane can say what it is doing. */
  connStatus: ConnStatus;
  /** Why creating a session failed, shown on the chat pane with a retry. */
  createError: string | null;
  /** The session whose kiro process is being restarted, if any. */
  reloadingId: string | null;
  /** File the user asked to look at, relative to the workspace. Set by the file tree
   *  and by a read/write tool call in the transcript; null when nothing is open. */
  previewPath: string | null;

  // actions
  bumpFsPath: (path: string) => void;
  setWatchedPaths: (paths: string[]) => void;
  setChats: (s: ChatSummary[]) => void;
  setModels: (m: ModelInfo[]) => void;
  setAgents: (a: AgentMode[], defaultAgentId: string) => void;
  setLoadingChat: (id: string | null) => void;
  loadDetail: (d: ChatDetail, opts?: { keepPending?: boolean }) => void;
  prependItems: (older: TranscriptItem[]) => void;
  clearActive: () => void;
  /** Start a new chat's identity, before it has a session. */
  newChatId: () => string;
  applyEvent: (e: CasperEvent) => void;
  addPending: (pending: Omit<PendingMessage, 'status'>) => void;
  markPendingFailed: (id: string, error?: string) => void;
  dismissChatNotice: () => void;
  /** Pin a condition above the composer, for a failure with no turn to attach to. */
  setSessionNotice: (notice: ChatNotice) => void;
  setConnStatus: (status: ConnStatus) => void;
  setCreateError: (message: string | null) => void;
  setReloadingId: (id: string | null) => void;
  openFilePreview: (path: string) => void;
  closeFilePreview: () => void;
  // Optimistic transitions. Here rather than at the call site because applyEvent
  // owns the same fields when the server's echo arrives, and a transition split
  // across two modules is one nobody can read in one place.
  markCancelling: () => void;
  setCurrentModel: (modelId: string) => void;
  setCurrentAgent: (modeId: string) => void;
  setCompacting: (compacting: boolean) => void;
  markPendingSending: (id: string) => void;
  renameSessionRow: (id: string, title: string) => void;
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

  // Optimistic feedback: the Stop button flips to "Stopping…" until the server
  // confirms with turn_ended / turn_error, which reset to idle.
  markCancelling: () =>
    set((s) =>
      s.observability.turnStatus === 'running'
        ? { observability: { ...s.observability, turnStatus: 'cancelling' } }
        : {},
    ),

  setCurrentModel: (currentModelId) => set({ currentModelId }),

  // Optimistic in both the picker (currentModeId) and the sidebar row (agentId),
  // so neither waits for the next listChats.
  setCurrentAgent: (modeId) =>
    set((s) => ({
      currentModeId: modeId,
      chats: s.activeId
        ? s.chats.map((sess) =>
            sess.chatId === s.activeId ? { ...sess, agentId: modeId } : sess,
          )
        : s.chats,
    })),

  // No-op when already in that state, so the safety-net clear cannot undo a real
  // completion or cost a render for nothing.
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

  renameSessionRow: (id, title) =>
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
      // The detail knows this session's title before the next list fetch does.
      chats: upsertChat(s.chats, d.summary),
      modes: d.modes,
      currentModeId: d.currentModeId,
      currentModelId: d.summary.modelId,
      observability: d.observability,
      items: d.transcript,
      // The fetched transcript already contains every event up to head, so
      // anything replayed at or below it is a duplicate.
      appliedSeq: d.head,
      remainingOlder: Math.max(0, d.transcriptTotal - d.transcript.length),
      streamingText: '',
      streamingThought: '',
      // Switching chats drops optimistic bubbles, but adopting the session a draft
      // just created must keep the message that created it.
      pending: opts?.keepPending ? s.pending : [],
      chatNotice: null,
    })),

  // Prepend an older page (loaded on scroll-up). remainingOlder shrinks by the
  // number actually returned so it converges to 0 when the head is reached.
  prependItems: (older) =>
    set((s) => ({
      items: [...older, ...s.items],
      remainingOlder: Math.max(0, s.remainingOlder - older.length),
    })),

  newChatId: () => {
    const chatId = crypto.randomUUID();
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
    }),

  dismissChatNotice: () => set({ chatNotice: null }),
  setSessionNotice: (chatNotice) => set({ chatNotice }),

  // An object, not positional args: a caller that forgets one is a type error rather than
  // a silently dropped field.
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

    // Events are strictly ordered per session, so anything at or below the
    // high-water mark has already been folded in. Replays overlap by design
    // and a dropped connection can re-deliver, so drop duplicates here rather
    // than trusting every transport path to be exactly-once.
    if (e.seq <= state.appliedSeq) return;
    set({ appliedSeq: e.seq });

    switch (p.kind) {
      case 'turn_started': {
        const rawText = p.prompt
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const text = stripAttachmentsLine(rawText);
        // Drop the oldest optimistic bubble still marked 'sending' - turns are
        // serialized server-side, so this turn_started is that send's echo.
        const sendingIdx = state.pending.findIndex((pm) => pm.status === 'sending');
        // Float this session to the top of the sidebar right away. The server
        // orders by updatedAt, which only changes once kiro persists the turn,
        // so bump it optimistically now; turn_ended reconciles from the server.
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
          // A turn got through, so whatever was blocking the session isn't
          // blocking it any more.
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
          // Conditions that outlive the turn get pinned above the composer too,
          // since the next send will hit the same wall.
          chatNotice: failure.sessionWide
            ? { title: failure.title, fix: failure.fix, detail: p.message }
            : state.chatNotice,
          streamingText: '',
          streamingThought: '',
          observability: { ...state.observability, turnStatus: 'idle' },
        });
        break;
      }

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

      case 'process_exited':
        // compacting too: only a completed/failed notification clears it, which a dead
        // process never sends, and while set it disables the composer.
        set({
          observability: { ...state.observability, turnStatus: 'idle', compacting: false },
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
