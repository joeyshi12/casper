import { useEffect, useState } from 'react';
import { getHighlighter } from '../../util/highlighter.js';

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
