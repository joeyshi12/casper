import { useEffect, useRef } from 'react';
import { useStore } from '../../state/store.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard } from './ToolCallCard.js';

/**
 * The conversation transcript. Auto-scrolls to the bottom as new content
 * arrives (unless the user has scrolled up to read history).
 */
export function Transcript() {
  const items = useStore((s) => s.items);
  const streamingText = useStore((s) => s.streamingText);
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [items, streamingText]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const empty = items.length === 0 && !streamingText;

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {empty && (
        <div className="transcript-empty">
          <p className="empty-title">Casper is here.</p>
          <p className="empty-sub">
            Hand off a task and put your phone down. Casper keeps working in the
            dark and has it ready when you get back.
          </p>
        </div>
      )}

      {items.map((item, i) =>
        item.type === 'message' ? (
          <div
            key={item.message.id + i}
            className={`msg msg-${item.message.role}`}
          >
            {item.message.role === 'assistant' ? (
              <MarkdownRenderer text={item.message.text} />
            ) : (
              <div className="msg-user-text">{item.message.text}</div>
            )}
          </div>
        ) : (
          <ToolCallCard key={item.tool.id + i} tool={item.tool} />
        ),
      )}

      {streamingText && (
        <div className="msg msg-assistant">
          <MarkdownRenderer text={streamingText} />
        </div>
      )}

      {turnStatus === 'running' && !streamingText && (
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
