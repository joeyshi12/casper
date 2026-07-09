import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard } from './ToolCallCard.js';

interface Props {
  onRetry: (id: string, text: string) => void;
}

/**
 * The conversation transcript. Auto-scrolls to the bottom as new content
 * arrives (unless the user has scrolled up to read history).
 */
export function Transcript({ onRetry }: Props) {
  const items = useStore((s) => s.items);
  const streamingText = useStore((s) => s.streamingText);
  const streamingThought = useStore((s) => s.streamingThought);
  const pending = useStore((s) => s.pending);
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [items, streamingText, streamingThought, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const empty =
    items.length === 0 && !streamingText && !streamingThought && pending.length === 0;

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {empty && (
        <div className="transcript-empty">
          <p className="empty-title">Casper is here.</p>
          <p className="empty-sub">
            Hand off a task. Casper keeps working server-side and has it ready
            when you get back.
          </p>
        </div>
      )}

      {items.map((item) =>
        item.type === 'message' ? (
          item.message.role === 'thinking' ? (
            <ThoughtBlock key={item.message.id} text={item.message.text} />
          ) : (
            <div key={item.message.id} className={`msg msg-${item.message.role}`}>
              {item.message.role === 'assistant' ? (
                <MarkdownRenderer text={item.message.text} />
              ) : (
                <div className="msg-user-text">{item.message.text}</div>
              )}
            </div>
          )
        ) : (
          <ToolCallCard key={item.tool.id} tool={item.tool} />
        ),
      )}

      {pending.map((pm) => (
        <div
          key={pm.id}
          className={`msg msg-user msg-pending ${pm.status === 'failed' ? 'is-failed' : ''}`}
        >
          <div className="msg-user-text">{pm.text}</div>
          {pm.status === 'failed' && (
            <button
              className="msg-retry"
              onClick={() => onRetry(pm.id, pm.text)}
              title="Failed to send. Click to retry."
            >
              Retry
            </button>
          )}
        </div>
      ))}

      {streamingThought && <ThoughtBlock text={streamingThought} live />}

      {streamingText && (
        <div className="msg msg-assistant">
          <MarkdownRenderer text={streamingText} />
        </div>
      )}

      {turnStatus === 'running' && !streamingText && !streamingThought && (
        <div className="thinking">
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

/**
 * A collapsible reasoning block. Kiro's "thinking" content is the model's
 * private reasoning; we render it dimmed and distinct from spoken output.
 * Collapsed by default for committed thoughts; expanded while streaming live.
 */
function ThoughtBlock({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(live);
  return (
    <div className={`thought ${live ? 'is-live' : ''}`}>
      <button className="thought-head" onClick={() => setOpen((o) => !o)}>
        <span className="thought-chevron">{open ? '▾' : '▸'}</span>
        <span className="thought-label">Thinking</span>
      </button>
      {open && (
        <div className="thought-body">
          <MarkdownRenderer text={text} />
        </div>
      )}
    </div>
  );
}
