import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { api } from '../../api/rest.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard } from './ToolCallCard.js';

interface Props {
  onRetry: (id: string, text: string) => void;
}

/**
 * The conversation transcript. Autoscroll (following new content to the bottom)
 * is opt-in: it turns on only when the user clicks the jump-to-latest button,
 * and turns off again the moment they scroll up. On opening a session the view
 * jumps to the latest message once, without enabling continuous follow.
 *
 * Memoized: toggling unrelated ChatPane state (like the file panel) must not
 * re-render the whole transcript, which is expensive for long histories.
 */
export const Transcript = memo(function Transcript({ onRetry }: Props) {
  const items = useStore((s) => s.items);
  const streamingText = useStore((s) => s.streamingText);
  const streamingThought = useStore((s) => s.streamingThought);
  const pending = useStore((s) => s.pending);
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const activeId = useStore((s) => s.activeId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Following the bottom as new content streams in. Off until the user opts in
  // via the jump-to-latest button.
  const followBottom = useRef(false);
  // Last observed scrollTop, to tell a user scroll-up from a programmatic
  // scroll-down (which only ever increases scrollTop).
  const lastScrollTop = useRef(0);
  // Session id we have already positioned at the bottom for.
  const initializedFor = useRef<string | null>(null);
  // Pending-message count last seen, to detect a fresh user send.
  const prevPendingLen = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Each session starts with autoscroll off (covers switching to an empty
  // session, where the content effect's init branch does not run).
  useEffect(() => {
    followBottom.current = false;
    prevPendingLen.current = 0;
    setShowScrollBtn(false);
  }, [activeId]);

  const updateScrollBtn = (el: HTMLDivElement) => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distanceFromBottom > 240);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // First content for a freshly opened session: jump to the latest message
    // once (no smooth animation, no continuous follow).
    if (initializedFor.current !== activeId && items.length > 0) {
      initializedFor.current = activeId;
      followBottom.current = false;
      bottomRef.current?.scrollIntoView({ block: 'end' });
      lastScrollTop.current = el.scrollTop;
      prevPendingLen.current = pending.length;
      setShowScrollBtn(false);
      return;
    }
    // A new pending message means the user just sent a prompt: resume following
    // so their message and the streamed reply stay in view.
    if (pending.length > prevPendingLen.current) {
      followBottom.current = true;
    }
    prevPendingLen.current = pending.length;
    if (followBottom.current) {
      // Instant (not smooth): while a turn streams, chunks arrive many times a
      // second and stacking smooth-scroll animations makes mobile scroll jitter.
      // The jump-to-latest button still animates smoothly (one-shot).
      bottomRef.current?.scrollIntoView({ block: 'end' });
      lastScrollTop.current = el.scrollTop;
    } else {
      updateScrollBtn(el);
    }
  }, [items, streamingText, streamingThought, pending, activeId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // A user scroll-up (scrollTop decreases) stops following. Programmatic
    // scroll-to-bottom only increases scrollTop, so it never trips this.
    if (el.scrollTop < lastScrollTop.current - 4) {
      followBottom.current = false;
    }
    lastScrollTop.current = el.scrollTop;
    updateScrollBtn(el);
  };

  const scrollToBottom = () => {
    followBottom.current = true;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  const empty =
    items.length === 0 && !streamingText && !streamingThought && pending.length === 0;

  return (
    <div className="transcript-wrap">
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
                <>
                  {activeId && item.message.imagePaths && item.message.imagePaths.length > 0 && (
                    <div className="msg-images">
                      {item.message.imagePaths.map((p) => (
                        <a
                          key={p}
                          href={api.previewUrl(activeId, p)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="msg-image-link"
                        >
                          <img
                            src={api.previewUrl(activeId, p)}
                            alt={p.split('/').pop() ?? 'image'}
                            className="msg-image"
                            loading="lazy"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {item.message.text && (
                    <div className="msg-user-text">{item.message.text}</div>
                  )}
                </>
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
      {showScrollBtn && (
        <button
          className="scroll-to-bottom"
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          title="Scroll to latest"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  );
});

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
