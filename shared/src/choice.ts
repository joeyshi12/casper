/**
 * How show_choice answers travel. The web sends the answers to a call's questions as JSON in
 * the elicitation's `answer` field; a message typed into the composer instead arrives as
 * plain text. Casper's MCP server turns either into the tool result the model reads, and the
 * web reads the answers back out of that result, so a reloaded chat still shows them.
 */

/** The answer to each question in order; null for one the user skipped. */
export type ChoiceAnswers = (string | null)[];

const ANSWERED = 'The user answered:';
const REPLIED = 'The user replied instead of picking: ';
const SKIPPED = 'The user skipped the questions';
const SKIP_MARK = '(skipped)';

export function encodeChoiceAnswers(answers: ChoiceAnswers): string {
  return JSON.stringify({ answers });
}

/** The answers in an elicitation `answer`, or null when it is a typed reply instead. */
export function decodeChoiceAnswers(raw: string, count: number): ChoiceAnswers | null {
  try {
    const parsed = JSON.parse(raw) as { answers?: unknown };
    const a = parsed?.answers;
    if (!Array.isArray(a) || a.length !== count) return null;
    return a.map((x) => (typeof x === 'string' && x.trim() ? x.trim() : null));
  } catch {
    return null;
  }
}

/** `text` on one line, so it fits on a line of the tool result. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** The tool result for answers to `questions`, one line each. */
export function formatChoiceAnswers(questions: string[], answers: ChoiceAnswers): string {
  const lines = questions.map((q, i) => `- ${oneLine(q)} → ${answers[i] ? oneLine(answers[i]) : SKIP_MARK}`);
  return [ANSWERED, ...lines].join('\n');
}

export function formatChoiceReply(text: string): string {
  return `${REPLIED}${text}`;
}

export function formatChoiceSkipped(): string {
  return `${SKIPPED}. Carry on using your own judgement.`;
}

export type ChoiceResult =
  | { kind: 'answers'; answers: ChoiceAnswers }
  | { kind: 'reply'; text: string }
  | { kind: 'skipped' };

/** What a show_choice result says the user did, or null for a call closed without one. */
export function parseChoiceResult(text: string, questions: string[]): ChoiceResult | null {
  if (text.startsWith(REPLIED)) return { kind: 'reply', text: text.slice(REPLIED.length).trim() };
  if (text.startsWith(SKIPPED)) return { kind: 'skipped' };
  if (!text.startsWith(ANSWERED)) return null;
  // Line i holds question i.
  const lines = text.slice(ANSWERED.length).split('\n').filter((l) => l.startsWith('- '));
  const answers = questions.map((q, i) => {
    const head = `- ${oneLine(q)} → `;
    const value = lines[i]?.startsWith(head) ? lines[i].slice(head.length).trim() : '';
    return value && value !== SKIP_MARK ? value : null;
  });
  return { kind: 'answers', answers };
}
