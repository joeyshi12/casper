import type { SessionUpdate, ToolCallProgressUpdate, ToolCallUpdate } from './acp.js';
import type { TranscriptItem } from './rest-dto.js';

/** Streamed text is held in the draft and committed as messages by the next tool call or
 *  the end of the turn. */
export interface TurnDraft {
  items: TranscriptItem[];
  streamingText: string;
  streamingThought: string;
}

export const emptyDraft = (): TurnDraft => ({ items: [], streamingText: '', streamingThought: '' });

/** baseId must be unique per commit so React keys stay stable. */
export function commitDraft(draft: TurnDraft, baseId: string, ts = Date.now()): TranscriptItem[] {
  const next = [...draft.items];
  if (draft.streamingThought.trim()) {
    next.push({
      type: 'message',
      message: {
        id: `t-${baseId}`,
        role: 'thinking',
        text: draft.streamingThought.trim(),
        timestamp: ts,
      },
    });
  }
  if (draft.streamingText.trim()) {
    next.push({
      type: 'message',
      message: { id: `a-${baseId}`, role: 'assistant', text: draft.streamingText, timestamp: ts },
    });
  }
  return next;
}

/** Tool calls still running when their turn ended will never report back. */
export function settleTools(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((it) =>
    it.type === 'tool_call' && (it.tool.status === 'pending' || it.tool.status === 'in_progress')
      ? { type: 'tool_call', tool: { ...it.tool, status: 'failed' } }
      : it,
  );
}

/** Applies one session update. Returns the same object when the update changes nothing. */
export function foldSessionUpdate(
  draft: TurnDraft,
  u: SessionUpdate,
  seq: number,
  ts: number,
): TurnDraft {
  if (u.sessionUpdate === 'agent_message_chunk') {
    const chunk = (u as { content?: { text?: string } }).content?.text ?? '';
    return { ...draft, streamingText: draft.streamingText + chunk };
  }
  if (u.sessionUpdate === 'agent_thought_chunk') {
    const chunk = (u as { content?: { text?: string } }).content?.text ?? '';
    return { ...draft, streamingThought: draft.streamingThought + chunk };
  }
  if (u.sessionUpdate === 'tool_call') {
    const tc = u as ToolCallUpdate;
    const toolName = (tc as { _meta?: { kiro?: { toolName?: string } } })._meta?.kiro?.toolName;
    return {
      items: [
        ...commitDraft(draft, `s-${seq}`, ts),
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
    };
  }
  if (u.sessionUpdate === 'tool_call_update') {
    const tu = u as ToolCallProgressUpdate;
    return {
      ...draft,
      items: draft.items.map((it) =>
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
    };
  }
  return draft;
}
