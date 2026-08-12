import type { ToolCallView } from '../state/store.js';

/** kiro namespaces MCP tools, so match the suffix rather than the whole name. */
const TOOL_SUFFIX = 'show_widget';

interface WidgetCall {
  title: string;
  code: string;
}

/** The show_widget arguments, or null when this isn't that tool. */
export function widgetCallOf(tool: ToolCallView): WidgetCall | null {
  if (!tool.name?.endsWith(TOOL_SUFFIX)) return null;
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const code = typeof input.widget_code === 'string' ? input.widget_code : '';
  const title = typeof input.title === 'string' ? input.title : '';
  return { title, code };
}

export function prettyWidgetTitle(title: string): string {
  return title.replace(/_/g, ' ').trim();
}
