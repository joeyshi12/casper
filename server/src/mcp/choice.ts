/**
 * The one first-party template: data in, Casper's own markup out, so no sandbox.
 * Validated here so bad data comes back as something the model can fix.
 */

export const MAX_OPTIONS = 6;

/** Human-readable problem, or null when the data is usable. */
export function validateChoice(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'arguments must be an object.';
  }
  const d = data as Record<string, unknown>;
  if (typeof d.question !== 'string' || !d.question.trim()) {
    return 'question is required: what you are asking the user to decide.';
  }
  if (!Array.isArray(d.options) || d.options.length < 2) {
    return 'at least two options are needed.';
  }
  if (d.options.length > MAX_OPTIONS) {
    return `at most ${MAX_OPTIONS} options; ${d.options.length} is too many to tap through.`;
  }
  for (const [i, raw] of d.options.entries()) {
    if (typeof raw !== 'object' || raw === null) return `options[${i}] must be an object.`;
    const o = raw as Record<string, unknown>;
    if (typeof o.label !== 'string' || !o.label.trim()) {
      return `options[${i}].label is required and must be a short phrase.`;
    }
    if (o.prompt !== undefined && typeof o.prompt !== 'string') {
      return `options[${i}].prompt must be a string when given.`;
    }
    if (o.detail !== undefined && typeof o.detail !== 'string') {
      return `options[${i}].detail must be a string when given.`;
    }
  }
  return null;
}
