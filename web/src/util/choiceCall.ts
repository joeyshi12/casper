import { oneLine, parseChoiceResult, type ChoiceResult } from '@casper/shared';
import type { ToolCallView } from '../state/store.js';
import { outputText } from './toolRender.js';
import { leadInOf } from './widgetCall.js';

interface ChoiceOption {
  label: string;
  /** What the answer says when this is picked. The label is the sensible default. */
  prompt: string;
}

export interface ChoiceQuestion {
  question: string;
  options: ChoiceOption[];
}

export interface ChoiceData {
  /** The sentence that introduces the questions, shown above them. */
  leadIn: string;
  questions: ChoiceQuestion[];
}

function questionOf(raw: unknown): ChoiceQuestion | null {
  const q = (raw ?? {}) as Record<string, unknown>;
  const question = typeof q.question === 'string' ? q.question.trim() : '';
  const options: ChoiceOption[] = [];
  for (const item of Array.isArray(q.options) ? q.options : []) {
    const o = (item ?? {}) as Record<string, unknown>;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label : '';
    if (!label) continue;
    const prompt = typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt : label;
    options.push({ label, prompt });
  }
  return question && options.length >= 2 ? { question, options } : null;
}

/**
 * The choice a call renders, or null. Also null for malformed data: the server
 * validates first, so anything unparseable here is better dropped than half-drawn.
 */
export function choiceCallOf(tool: ToolCallView): ChoiceData | null {
  // kiro namespaces MCP tools, so match the suffix rather than the whole name.
  if (!tool.name?.endsWith('show_choice')) return null;
  const data = (tool.input ?? {}) as Record<string, unknown>;
  const questions = (Array.isArray(data.questions) ? data.questions : []).map(questionOf);
  if (questions.length === 0 || questions.some((q) => !q)) return null;
  return { leadIn: leadInOf(data), questions: questions as ChoiceQuestion[] };
}

/**
 * What the user did, read out of the call's result, or null while the call is open or when
 * it closed without an answer. kiro reports the result live as `rawOutput` with `response`
 * and `message` fields, and as plain text in its file.
 */
export function choiceResultOf(tool: Pick<ToolCallView, 'content' | 'output'>, data: ChoiceData): ChoiceResult | null {
  const out = tool.output as { response?: unknown; message?: unknown } | string | undefined;
  const texts = [
    typeof out === 'string' ? out : undefined,
    typeof out === 'object' && out !== null && typeof out.response === 'string' ? out.response : undefined,
    typeof out === 'object' && out !== null && typeof out.message === 'string' ? out.message : undefined,
    outputText(Array.isArray(tool.content) ? tool.content : []),
  ];
  const questions = data.questions.map((q) => q.question);
  for (const t of texts) {
    const parsed = t ? parseChoiceResult(t, questions) : null;
    if (parsed) return parsed;
  }
  return null;
}

/** The label of the option an answer picked, or the answer itself when it was typed. */
export function answerLabel(question: ChoiceQuestion, answer: string): string {
  // The result holds each answer on one line, so compare one-line forms.
  return question.options.find((o) => oneLine(o.prompt) === oneLine(answer))?.label ?? answer;
}
