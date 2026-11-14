/**
 * The one first-party template: data in, Casper's own markup out, so no sandbox.
 * Validated here so bad data comes back as something the model can fix.
 */

export const MAX_OPTIONS = 6;
export const MAX_QUESTIONS = 3;

function optionsProblem(options: unknown, at: string): string | null {
  if (!Array.isArray(options) || options.length < 2) return `${at}options needs at least two options.`;
  if (options.length > MAX_OPTIONS) {
    return `${at}options has ${options.length}; at most ${MAX_OPTIONS} fit on screen.`;
  }
  for (const [i, raw] of options.entries()) {
    if (typeof raw !== 'object' || raw === null) return `${at}options[${i}] must be an object.`;
    const o = raw as Record<string, unknown>;
    if (typeof o.label !== 'string' || !o.label.trim()) {
      return `${at}options[${i}].label is required and must be a short phrase.`;
    }
    if (o.prompt !== undefined && typeof o.prompt !== 'string') {
      return `${at}options[${i}].prompt must be a string when given.`;
    }
  }
  return null;
}

/** Human-readable problem, or null when the data is usable. */
export function validateChoice(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'arguments must be an object.';
  }
  const qs = (data as Record<string, unknown>).questions;
  if (!Array.isArray(qs) || qs.length === 0) {
    return 'questions is required: one to three questions, each with its options.';
  }
  if (qs.length > MAX_QUESTIONS) {
    return `questions has ${qs.length}; ask at most ${MAX_QUESTIONS} at once.`;
  }
  for (const [i, raw] of qs.entries()) {
    const at = `questions[${i}].`;
    if (typeof raw !== 'object' || raw === null) return `questions[${i}] must be an object.`;
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== 'string' || !q.question.trim()) {
      return `${at}question is required: what you are asking the user to decide.`;
    }
    const problem = optionsProblem(q.options, at);
    if (problem) return problem;
  }
  return null;
}

/** The question texts of validated arguments, in order. */
export function questionTexts(data: Record<string, unknown>): string[] {
  return (data.questions as { question: string }[]).map((q) => q.question.trim());
}
