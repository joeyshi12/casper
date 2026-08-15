import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * Remark plugins for rendered markdown, hoisted so ReactMarkdown is not handed a new
 * array on every render.
 *
 * Single-dollar math stays on, because "$x^2$" is worth rendering. Currency is handled
 * before parsing instead, by escapeCurrencyDollars, which judges each pair on its
 * contents - see web/src/util/currencyDollars.ts.
 */
export const REMARK_PLUGINS = [remarkGfm, remarkMath] as const;
