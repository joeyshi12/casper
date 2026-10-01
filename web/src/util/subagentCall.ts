import type { ToolCallView } from '../state/store.js';

/** True for the `subagent` tool call, which renders as its own list of subagents
 *  rather than a plain tool line - it is the point of its own call, like show_widget
 *  and show_choice, so it is never folded into a run of tool lines either. */
export function isSubagentCall(tool: ToolCallView): boolean {
  return tool.name === 'subagent';
}
