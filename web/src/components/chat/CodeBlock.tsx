import { useEffect, useState } from 'react';
import { highlightToHtml } from '../../util/highlighter.js';

interface Props {
  code: string;
  lang: string;
}

export function CodeBlock({ code, lang }: Props) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlightToHtml(code, lang)
      .then((out) => {
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
