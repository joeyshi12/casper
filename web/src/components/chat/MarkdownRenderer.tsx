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
  /** Render the file's own HTML, sanitised. For files the user opened, not agent output. */
  html?: boolean;
  /** Still arriving: wrap words so the new ones fade in. Off for settled text. */
  streaming?: boolean;
}

// Hoisted: the code renderer runs per fenced block on every streamed chunk.
const LANG_CLASS = /language-(\w+)/;
const TRAILING_NEWLINE = /\n$/;

// Hoisted so the object identity is stable across renders (these have no
// closure dependencies), letting ReactMarkdown skip re-processing on each pass.
const MD_COMPONENTS: Components = {
  code(props) {
    const { className, children } = props;
    const match = LANG_CLASS.exec(className ?? '');
    const raw = String(children).replace(TRAILING_NEWLINE, '');
    // Inline code (no language, single line) stays inline.
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

/**
 * KaTeX and its stylesheet are the largest thing in the entry chunk and most messages have
 * no maths, so they stay out of it. They are still fetched during the first idle period
 * after paint rather than on first sight of maths: arriving late would re-render a message
 * from raw `$...$` into typeset maths, and that changes its height.
 */
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

/** A dollar sign escapeCurrencyDollars left alone, meaning it really is math. */
const UNESCAPED_DOLLAR = /(^|[^\\])\$/;

/**
 * Renders Markdown with GFM, LaTeX math ($inline$ and $$display$$), routing
 * fenced code to Shiki and ```mermaid to the diagram renderer. Memoized so
 * streaming re-renders stay cheap.
 */
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
    // No maths here: warm it for whatever arrives next, off the critical path.
    if (!needsMath) {
      preloadKatexWhenIdle();
      return;
    }
    // Maths already on screen and the idle fetch hasn't landed: load now and re-render.
    let alive = true;
    void loadKatex().then(() => {
      if (alive) setKatexReady(true);
    });
    return () => {
      alive = false;
    };
  }, [needsMath]);

  // Memoized rather than hoisted, for the same reason the constants above are hoisted: a
  // new array each render makes ReactMarkdown reprocess. KaTeX stays ahead of
  // rehypeFadeWords, which would otherwise wrap words inside a math span, and behind the
  // sanitiser, so the schema judges the file's HTML and not KaTeX's output.
  const rehypePlugins = useMemo<RehypePlugins>(() => {
    const math: RehypePlugins = needsMath && katexPlugin ? [katexPlugin] : [];
    if (html) return [rehypeRaw, [rehypeSanitize, MARKDOWN_HTML_SCHEMA], ...math];
    if (streaming) return [...math, rehypeFadeWords];
    return math;
    // katexReady is the signal that katexPlugin became available.
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
