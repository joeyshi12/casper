import type { ToolCallView } from '../../state/store.js';
import { WidgetBlock } from './WidgetBlock.js';
import { prettyWidgetTitle, widgetCallOf } from '../../util/widgetCall.js';

/**
 * The call is the delivery mechanism, so this renders its arguments; the result is
 * only kiro's acknowledgement.
 */
export function WidgetToolCall({ tool }: { tool: ToolCallView }) {
  const call = widgetCallOf(tool);
  if (!call) return null;

  if (tool.status === 'failed') {
    return <div className="widget-error">Widget {prettyWidgetTitle(call.title) || 'call'} failed.</div>;
  }
  // kiro reports the arguments with the call, so there is nothing to wait for.
  if (!call.code) return null;

  return <WidgetBlock code={call.code} />;
}
