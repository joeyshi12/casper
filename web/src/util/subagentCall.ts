import { SUBAGENT_TOOL } from '@casper/shared';
import type { ToolCallView } from '../state/store.js';

/** True for the `invoke_sub_agent` call that starts a subagent, which renders as its
 *  subagent's row rather than a plain tool line - it is the point of its own call, like
 *  show_widget and show_choice, so it is never folded into a run of tool lines either. */
export function isSubagentCall(tool: ToolCallView): boolean {
  return tool.name === SUBAGENT_TOOL;
}
