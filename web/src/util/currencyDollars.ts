/**
 * Tells currency apart from inline math in markdown source.
 *
 * remark-math treats every `$...$` pair as math, so two dollar amounts in a sentence
 * render the prose between them as one formula. Disabling single-dollar math loses real
 * inline math, which is worse - so this judges each pair by its content and escapes only
 * the rejected ones, before parsing.
 */

/** A LaTeX command, superscript or subscript settles it immediately. */
const NOTATION = /\\[a-zA-Z]+|[\^_]/;
/** Money: digits with optional grouping, decimals and a scale suffix. */
const AMOUNT = /^\d[\d,.]*\s*(?:[kKmMbB]|bn|billion|million|thousand)?$/;
/** Words as prose rather than variables. */
const WORD = /^[a-zA-Z]{3,}$/;
const OPERATOR = /[=+\-*/<>≤≥±×÷]/;

/**
 * Whether the text between two dollar signs is mathematical. Errs toward math only when
 * there is positive evidence, since a false positive is what mangles a paragraph.
 */
export function looksLikeMath(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  // Newlines inside a single-dollar pair mean the pair spans unrelated lines.
  if (/\n/.test(content)) return false;
  if (NOTATION.test(text)) return true;
  if (AMOUNT.test(text)) return false;

  const words = text.split(/\s+/);
  // Prose: several real words, or any word long enough to be a word rather than a symbol.
  const proseWords = words.filter((w) => WORD.test(w.replace(/[.,;:!?]$/, '')));
  if (proseWords.length >= 2) return false;
  // A comma-grouped number anywhere reads as an amount, not an expression.
  if (/\d,\d{3}\b/.test(text)) return false;

  // A short symbolic run is math: x, n, 2n, a+b, E = mc, \pi.
  const symbolic = words.every((w) => w.length <= 4);
  if (symbolic && (words.length === 1 || OPERATOR.test(text))) return true;
  if (OPERATOR.test(text) && proseWords.length === 0) return true;
  return false;
}

/** Where a run of source is not subject to markdown inline parsing. */
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

/**
 * Escape the dollar signs of pairs that are not math, leaving code spans, fenced blocks
 * and `$$` display math alone.
 */
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
      // Display or two-dollar text math: hand it over untouched.
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
        if (!looksLikeMath(content)) {
          // Escape the opener only, and reconsider the closer: in "$30 ... $x^2$" the
          // dollar that ended this pair is the one that starts the real math.
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
