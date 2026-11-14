import { CHOICE_ANSWER_PREFIX } from '@casper/shared';
import type { ToolCallView } from '../state/store.js';
import { outputText } from './toolRender.js';

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

/**
 * What the user answered, read out of the call's result, or null when the call returned
 * without one. kiro reports the result live as `rawOutput` with `response` and `message`
 * fields, and as plain text in its file.
 */
export function choiceAnswerOf(tool: Pick<ToolCallView, 'content' | 'output'>): string | null {
  const out = tool.output as { response?: unknown; message?: unknown } | string | undefined;
  const texts = [
    typeof out === 'string' ? out : undefined,
    typeof out === 'object' && out !== null && typeof out.response === 'string' ? out.response : undefined,
    typeof out === 'object' && out !== null && typeof out.message === 'string' ? out.message : undefined,
    outputText(Array.isArray(tool.content) ? tool.content : []),
  ];
  for (const t of texts) {
    if (t?.startsWith(CHOICE_ANSWER_PREFIX)) return t.slice(CHOICE_ANSWER_PREFIX.length).trim() || null;
  }
  return null;
}

export interface ChoiceOutcome {
  /** Label of the option the user took, if they took one. */
  picked: string | null;
  /** They said something else instead, so the question has been left behind. */
  superseded: boolean;
}

/**
 * What became of a choice, judged by the user's answer: one of the options, or something
 * else entirely. Either way the question is closed - offering buttons for a moment that has
 * passed invites answering a question twice.
 */
export function choiceOutcome(
  options: ChoiceData['options'],
  reply: string | null,
): ChoiceOutcome {
  if (reply === null) return { picked: null, superseded: false };
  const hit = options.find((o) => o.prompt.trim() === reply.trim());
  return hit ? { picked: hit.label, superseded: false } : { picked: null, superseded: true };
}
