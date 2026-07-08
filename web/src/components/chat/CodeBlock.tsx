import { useEffect, useState } from 'react';
import type { Highlighter } from 'shiki';

/** Lazy-load a single Shiki highlighter shared across all code blocks. */
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['aurora-x'],
        langs: [
          'typescript',
          'javascript',
          'tsx',
          'jsx',
          'json',
          'bash',
          'python',
          'rust',
          'go',
          'java',
          'yaml',
          'markdown',
          'html',
          'css',
          'sql',
          'diff',
        ],
      }),
    );
  }
  return highlighterPromise;
}

interface Props {
  code: string;
  lang: string;
}

export function CodeBlock({ code, lang }: Props) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        const supported = hl.getLoadedLanguages().includes(lang as never);
        const out = hl.codeToHtml(code, {
          lang: supported ? lang : 'text',
          theme: 'aurora-x',
        });
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const copy = () => void navigator.clipboard?.writeText(code);

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{lang || 'text'}</span>
        <button className="codeblock-copy" onClick={copy} aria-label="Copy code">
          copy
        </button>
      </div>
      {html ? (
        <div className="codeblock-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="codeblock-body codeblock-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
