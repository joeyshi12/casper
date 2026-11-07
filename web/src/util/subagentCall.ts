import { SUBAGENT_TOOL } from '@casper/shared';
import type { ToolCallView } from '../state/store.js';

/** True for a tool call that starts subagents: kiro V3's `invoke_sub_agent`, or the
 *  `subagent` call of a kiro 2.x session. It renders as its own list of subagents
 *  rather than a plain tool line - it is the point of its own call, like show_widget
 *  and show_choice, so it is never folded into a run of tool lines either. */
export function isSubagentCall(tool: ToolCallView): boolean {
  return tool.name === SUBAGENT_TOOL || tool.name === 'subagent';
}
