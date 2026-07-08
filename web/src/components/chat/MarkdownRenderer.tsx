import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock.js';
import { MermaidBlock } from './MermaidBlock.js';

interface Props {
  text: string;
}

/**
 * Renders Markdown with GFM, routing fenced code to Shiki and ```mermaid to the
 * diagram renderer. Memoized so streaming re-renders stay cheap.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ text }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
