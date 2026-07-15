import type { Highlighter } from 'shiki';

/**
 * A single Shiki highlighter, created with NO languages. Grammars are loaded
 * lazily per language on first use (see highlightToHtml), so the browser only
 * fetches the handful of language chunks actually rendered instead of the
 * ~30 we support (each grammar is a separate, sometimes large, JS chunk).
 */
let highlighterPromise: Promise<Highlighter> | null = null;

function base(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter: create }) =>
      create({ themes: ['aurora-x'], langs: [] }),
    );
  }
  return highlighterPromise;
}

const loaded = new Set<string>();
const failed = new Set<string>();

/**
 * Highlight code to HTML with the aurora-x theme, loading the grammar on demand.
 * Falls back to plain text when the language is unknown/unsupported. Returns
 * null only if highlighting fails entirely (caller renders raw text).
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  try {
    const hl = await base();
    let useLang = 'text';
    if (lang && lang !== 'text' && !failed.has(lang)) {
      if (!loaded.has(lang)) {
        try {
          await hl.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0]);
          loaded.add(lang);
        } catch {
          failed.add(lang); // unknown grammar; render as plain text
        }
      }
      if (hl.getLoadedLanguages().includes(lang)) useLang = lang;
    }
    return hl.codeToHtml(code, { lang: useLang, theme: 'aurora-x' });
  } catch {
    return null;
  }
}
