import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import 'katex/dist/katex.min.css';
import { MARKDOWN_HTML_SCHEMA } from '../../util/markdownHtml.js';
import { CodeBlock } from './CodeBlock.js';
import { MermaidBlock } from './MermaidBlock.js';

interface Props {
  text: string;
  /** Render the file's own HTML, sanitised. For files the user opened, not agent output. */
  html?: boolean;
}

// Hoisted so the object identity is stable across renders (these have no
// closure dependencies), letting ReactMarkdown skip re-processing on each pass.
const MD_COMPONENTS: Components = {
  code(props) {
    const { className, children } = props;
    const match = /language-(\w+)/.exec(className ?? '');
    const raw = String(children).replace(/\n$/, '');
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

// Hoisted for the same reason as the components: a new array each render makes
// ReactMarkdown reprocess. Sanitise between parsing the raw HTML and generating
// math markup, so the schema judges the file's HTML and not KaTeX's output.
const PLUGINS: Options['rehypePlugins'] = [rehypeKatex];
const HTML_PLUGINS: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_HTML_SCHEMA],
  rehypeKatex,
];

/**
 * Renders Markdown with GFM, LaTeX math ($inline$ and $$display$$), routing
 * fenced code to Shiki and ```mermaid to the diagram renderer. Memoized so
 * streaming re-renders stay cheap.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ text, html = false }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={html ? HTML_PLUGINS : PLUGINS}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
