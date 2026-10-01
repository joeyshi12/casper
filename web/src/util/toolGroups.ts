import type { TranscriptItem } from '@casper/shared';
import type { ToolCallView } from '../state/store.js';
import { widgetCallOf } from './widgetCall.js';
import { choiceCallOf } from './choiceCall.js';

/** A tool call inside a run or on its own line. */
export interface ToolEntry {
  type: 'tool';
  item: TranscriptItem & { type: 'tool_call' };
  tool: ToolCallView;
}

/** A thinking message inside a run or on its own line. */
export interface ThoughtEntry {
  type: 'thought';
  item: TranscriptItem & { type: 'message' };
  text: string;
}

/** Anything else in the transcript - an assistant or user message, a widget, a choice,
 *  a compaction marker, a turn error - rendered as before and never
 *  grouped. */
export interface OtherEntry {
  type: 'other';
  item: TranscriptItem;
}

/** A member of a run: a plain tool call or a thinking message, in transcript order. */
export type RunMember = ToolEntry | ThoughtEntry;

export type GroupedEntry = ToolEntry | ThoughtEntry | OtherEntry | { type: 'run'; members: RunMember[] };

/** A widget or a choice is the point of its own turn, not a tool
 *  to collapse into a run - each must render inline exactly where it arrived. */
function isPlainToolCall(tool: ToolCallView): boolean {
  return !widgetCallOf(tool) && !choiceCallOf(tool);
}

function toRunMember(item: TranscriptItem): RunMember | null {
  if (item.type === 'tool_call' && isPlainToolCall(item.tool)) {
    return { type: 'tool', item, tool: item.tool };
  }
  if (item.type === 'message' && item.message.role === 'thinking') {
    return { type: 'thought', item, text: item.message.text };
  }
  return null;
}

/**
 * Transcript items with consecutive runs of thinking messages and plain tool calls folded
 * into one group. A run needs at least two members: a single thought or tool call stays its
 * own entry so it is not wrapped in machinery it doesn't need. Anything else - an assistant
 * or user message, a widget, a choice, a compaction marker, a turn error
 * - breaks a run and passes through untouched.
 */
export function groupToolCalls(items: TranscriptItem[]): GroupedEntry[] {
  const out: GroupedEntry[] = [];
  let run: RunMember[] = [];

  const flush = () => {
    if (run.length === 1) out.push(run[0]!);
    else if (run.length > 1) out.push({ type: 'run', members: run });
    run = [];
  };

  for (const item of items) {
    const member = toRunMember(item);
    if (member) {
      run.push(member);
      continue;
    }
    flush();
    out.push({ type: 'other', item });
  }
  flush();

  return out;
}

/** Whether the live streaming thought should join the trailing run (or lone entry) rather
 *  than render as a separate block below it: when the last rendered entry is a run, a
 *  plain tool call, or a thought itself. */
export function lastEntryJoinsStreamingThought(entry: GroupedEntry | undefined): boolean {
  if (!entry) return false;
  return entry.type === 'run' || entry.type === 'tool' || entry.type === 'thought';
}
