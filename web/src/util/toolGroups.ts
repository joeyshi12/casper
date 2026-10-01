import type { TranscriptItem } from '@casper/shared';
import type { ToolCallView } from '../state/store.js';
import { widgetCallOf } from './widgetCall.js';
import { choiceCallOf } from './choiceCall.js';
import { isSubagentCall } from './subagentCall.js';

export interface ToolEntry {
  type: 'tool';
  item: TranscriptItem & { type: 'tool_call' };
  tool: ToolCallView;
}

export interface ThoughtEntry {
  type: 'thought';
  item: TranscriptItem & { type: 'message' };
  text: string;
}

export interface OtherEntry {
  type: 'other';
  item: TranscriptItem;
}

export type RunMember = ToolEntry | ThoughtEntry;

export type GroupedEntry = ToolEntry | ThoughtEntry | OtherEntry | { type: 'run'; members: RunMember[] };

// A widget, a choice, or the subagent list must render inline exactly where it
// arrived, so it never collapses into a run.
function isPlainToolCall(tool: ToolCallView): boolean {
  return !widgetCallOf(tool) && !choiceCallOf(tool) && !isSubagentCall(tool);
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

/* A run needs at least two members: a single thought or tool call stays its own
   entry rather than being wrapped in machinery it doesn't need. */
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

export function lastEntryJoinsStreamingThought(entry: GroupedEntry | undefined): boolean {
  if (!entry) return false;
  return entry.type === 'run' || entry.type === 'tool' || entry.type === 'thought';
}
