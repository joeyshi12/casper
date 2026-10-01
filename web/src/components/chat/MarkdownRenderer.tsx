import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import { REMARK_PLUGINS } from './markdownPlugins.js';
import { escapeCurrencyDollars } from '../../util/currencyDollars.js';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MARKDOWN_HTML_SCHEMA } from '../../util/markdownHtml.js';
import { rehypeFadeWords } from '../../util/rehypeFadeWords.js';
import { CodeBlock } from './CodeBlock.js';
import { MermaidBlock } from './MermaidBlock.js';

interface Props {
  text: string;
  html?: boolean;
  streaming?: boolean;
}

// Hoisted: the code renderer runs per fenced block on every streamed chunk.
const LANG_CLASS = /language-(\w+)/;
const TRAILING_NEWLINE = /\n$/;

// Hoisted so these keep stable object identity across renders, letting
// ReactMarkdown skip reprocessing on each pass.
const MD_COMPONENTS: Components = {
  code(props) {
    const { className, children } = props;
    const match = LANG_CLASS.exec(className ?? '');
    const raw = String(children).replace(TRAILING_NEWLINE, '');
    const isInline = !className && !raw.includes('\n');
    if (isInline) return <code className="md-inline-code">{raw}</code>;
    const lang = match?.[1] ?? '';
    if (lang === 'mermaid') return <MermaidBlock code={raw} />;
    return <CodeBlock code={raw} lang={lang} />;
  },
  a(props) {
    return <a {...props} target="_blank" rel="noreferrer noopener" />;
  },
};

type RehypePlugins = NonNullable<Options['rehypePlugins']>;

/* KaTeX and its stylesheet are the largest thing in the entry chunk and most
   messages have no maths, so they load lazily, during the first idle period after
   paint rather than on first sight of maths - arriving late would re-render a
   message into typeset maths and change its height. */
let katexPlugin: RehypePlugins[number] | null = null;
let katexLoad: Promise<void> | null = null;
function loadKatex(): Promise<void> {
  katexLoad ??= Promise.all([
    import('rehype-katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([mod]) => {
    katexPlugin = mod.default as RehypePlugins[number];
  });
  return katexLoad;
}

let idleQueued = false;
function preloadKatexWhenIdle(): void {
  if (idleQueued || katexPlugin) return;
  idleQueued = true;
  const start = () => void loadKatex();
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (idle) idle(start);
  else setTimeout(start, 2000);
}

const UNESCAPED_DOLLAR = /(^|[^\\])\$/;

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  html = false,
  streaming = false,
}: Props) {
  // Dollar amounts would otherwise be parsed as math, taking the prose between
  // them with them.
  const source = useMemo(() => escapeCurrencyDollars(text), [text]);
  const needsMath = UNESCAPED_DOLLAR.test(source);
  const [katexReady, setKatexReady] = useState(() => katexPlugin !== null);

  useEffect(() => {
    if (katexPlugin) return;
    if (!needsMath) {
      preloadKatexWhenIdle();
      return;
    }
    let alive = true;
    void loadKatex().then(() => {
      if (alive) setKatexReady(true);
    });
    return () => {
      alive = false;
    };
  }, [needsMath]);

  // Memoized rather than hoisted: a new array each render makes ReactMarkdown
  // reprocess. Order matters: KaTeX before rehypeFadeWords (so it doesn't wrap
  // words inside a math span), after the sanitiser (so it judges the file's
  // HTML, not KaTeX's output).
  const rehypePlugins = useMemo<RehypePlugins>(() => {
    const math: RehypePlugins = needsMath && katexPlugin ? [katexPlugin] : [];
    if (html) return [rehypeRaw, [rehypeSanitize, MARKDOWN_HTML_SCHEMA], ...math];
    if (streaming) return [...math, rehypeFadeWords];
    return math;
  }, [html, streaming, needsMath, katexReady]);

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS as unknown as Options['remarkPlugins']}
        rehypePlugins={rehypePlugins}
        components={MD_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
