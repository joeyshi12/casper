/**
 * remark-math treats every `$...$` pair as math, so two dollar amounts in a sentence
 * render the prose between them as one formula. This judges each pair by its content
 * and escapes only the ones that aren't math, before parsing.
 */

const NOTATION = /\\[a-zA-Z]+|[\^_]/;
const AMOUNT = /^\d[\d,.]*\s*(?:[kKmMbB]|bn|billion|million|thousand)?$/;
const WORD = /^[a-zA-Z]{3,}$/;
const OPERATOR = /[=+\-*/<>≤≥±×÷]/;
const TRAILING_PUNCT = /[.,;:!?]$/;
const NEWLINE = /\n/;
const WHITESPACE = /\s+/;
const GROUPED_NUMBER = /\d,\d{3}\b/;
const DIGIT = /\d/;

/** Whether the text between two dollar signs is mathematical. Errs toward math only
 *  when there is positive evidence, since a false positive mangles a paragraph. */
export function looksLikeMath(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (NEWLINE.test(content)) return false;
  if (NOTATION.test(text)) return true;
  if (AMOUNT.test(text)) return false;

  const words = text.split(WHITESPACE);
  const proseWords = words.filter((w) => WORD.test(w.replace(TRAILING_PUNCT, '')));
  if (proseWords.length >= 2) return false;
  if (GROUPED_NUMBER.test(text)) return false;

  const symbolic = words.every((w) => w.length <= 4);
  if (symbolic && (words.length === 1 || OPERATOR.test(text))) return true;
  if (OPERATOR.test(text) && proseWords.length === 0) return true;
  return false;
}

function skipCode(source: string, i: number): number {
  if (source.startsWith('```', i) || source.startsWith('~~~', i)) {
    const fence = source.slice(i, i + 3);
    const end = source.indexOf(`\n${fence}`, i + 3);
    return end === -1 ? source.length : end + 4;
  }
  if (source[i] === '`') {
    let ticks = 0;
    while (source[i + ticks] === '`') ticks++;
    const close = source.indexOf('`'.repeat(ticks), i + ticks);
    return close === -1 ? i + ticks : close + ticks;
  }
  return i;
}

export function escapeCurrencyDollars(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const skipped = skipCode(source, i);
    if (skipped > i) {
      out += source.slice(i, skipped);
      i = skipped;
      continue;
    }
    if (source[i] === '$' && source[i + 1] === '$') {
      // $$ is display or two-dollar text math: hand it over untouched.
      const close = source.indexOf('$$', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (source[i] === '$' && source[i - 1] !== '\\') {
      const close = source.indexOf('$', i + 1);
      if (close !== -1) {
        const content = source.slice(i + 1, close);
        // A closing dollar followed by a digit starts the next amount ("$5-$10"); Pandoc uses the same rule.
        if (DIGIT.test(source[close + 1] ?? '') || !looksLikeMath(content)) {
          // Escape the opener only and reconsider the closer: in "$30 ... $x^2$" that
          // dollar starts the real math.
          out += `\\$${content}`;
          i = close;
          continue;
        }
        out += source.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    out += source[i];
    i++;
  }
  return out;
}
