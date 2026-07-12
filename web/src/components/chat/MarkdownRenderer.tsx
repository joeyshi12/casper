import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { CodeBlock } from './CodeBlock.js';
import { MermaidBlock } from './MermaidBlock.js';

interface Props {
  text: string;
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

/**
 * Renders Markdown with GFM, LaTeX math ($inline$ and $$display$$), routing
 * fenced code to Shiki and ```mermaid to the diagram renderer. Memoized so
 * streaming re-renders stay cheap.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ text }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
