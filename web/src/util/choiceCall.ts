import type { ToolCallView } from '../state/store.js';

interface ChoiceOption {
  label: string;
  detail?: string;
  /** Sent when tapped. The label is the sensible default. */
  prompt: string;
}

export interface ChoiceData {
  question: string;
  options: ChoiceOption[];
}

/**
 * The choice a call renders, or null. Also null for malformed data: the server
 * validates first, so anything unparseable here is better dropped than half-drawn.
 */
export function choiceCallOf(tool: ToolCallView): ChoiceData | null {
  // kiro namespaces MCP tools, so match the suffix rather than the whole name.
  if (!tool.name?.endsWith('show_choice')) return null;
  const data = (tool.input ?? {}) as Record<string, unknown>;
  const question = typeof data.question === 'string' ? data.question.trim() : '';
  const raw = Array.isArray(data.options) ? data.options : [];
  const options: ChoiceOption[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label : '';
    if (!label) continue;
    const detail = typeof o.detail === 'string' && o.detail.trim() ? o.detail : undefined;
    const prompt = typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt : label;
    options.push({ label, detail, prompt });
  }
  if (!question || options.length < 2) return null;
  return { question, options };
}
