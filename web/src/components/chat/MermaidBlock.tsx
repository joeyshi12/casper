import { useEffect, useRef, useState } from 'react';

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        themeVariables: {
          primaryColor: '#3b4252',
          primaryTextColor: '#eceff4',
          primaryBorderColor: '#88c0d0',
          lineColor: '#81a1c1',
          fontFamily: 'Inter, sans-serif',
        },
      });
      return m.default;
    });
  }
  return mermaidReady;
}

let idCounter = 0;

// Renders a Mermaid diagram. mermaid.render() on invalid input throws and also
// injects an error graphic into document.body, and streamed code is incomplete
// on every frame. So we validate with parse({ suppressErrors: true }) first and
// only render valid input; anything else falls back to the raw source.
export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRendered(false);
    const trimmed = code.trim();
    if (!trimmed) return;

    void getMermaid()
      .then(async (mermaid) => {
        // parse() with suppressErrors returns false instead of throwing/injecting.
        const ok = await mermaid.parse(trimmed, { suppressErrors: true });
        if (cancelled || !ok) return;
        const { svg } = await mermaid.render(`mermaid-${idCounter++}`, trimmed);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        setRendered(true);
      })
      .catch(() => {
        /* stay in the raw-source fallback */
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="mermaid-wrap">
      {/* The rendered SVG target - empty (display:none) until a valid render. */}
      <div className={`mermaid-block ${rendered ? '' : 'is-hidden'}`} ref={ref} />
      {/* Raw-source fallback shown until (and unless) a valid diagram renders. */}
      {!rendered && (
        <div className="codeblock">
          <div className="codeblock-bar">
            <span className="codeblock-lang">mermaid</span>
          </div>
          <pre className="codeblock-body codeblock-plain">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
