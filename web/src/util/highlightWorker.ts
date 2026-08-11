import type { Highlighter } from 'shiki';

interface Request {
  id: number;
  code: string;
  lang: string;
}

interface Response {
  id: number;
  html: string | null;
}

// The DOM lib types `self` as a Window; in here it's the worker scope.
const ctx = self as unknown as {
  addEventListener(type: 'message', listener: (e: MessageEvent<Request>) => void): void;
  postMessage(message: Response): void;
};

/**
 * One highlighter with NO languages: grammars load on demand, so the worker only
 * fetches the language chunks actually rendered rather than all ~30.
 */
let highlighterPromise: Promise<Highlighter> | null = null;

function base(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: ['dracula'], langs: [] }),
    );
  }
  return highlighterPromise;
}

const loaded = new Set<string>();
const failed = new Set<string>();

ctx.addEventListener('message', (e) => {
  const { id, code, lang } = e.data;
  void (async () => {
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
      ctx.postMessage({ id, html: hl.codeToHtml(code, { lang: useLang, theme: 'dracula' }) });
    } catch {
      ctx.postMessage({ id, html: null });
    }
  })();
});
