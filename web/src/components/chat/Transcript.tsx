import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { olderPageRequest } from '../../state/pagination.js';
import { api } from '../../api/rest.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard } from './ToolCallCard.js';
import { CompressIcon, Spinner } from '../common/icons.js';

// Live media query (its .matches updates as the OS setting changes), so the
// easing follow can snap instantly for users who ask for reduced motion.
const reduceMotion =
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

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
  const compacting = useStore((s) => s.observability.compacting);
  const activeId = useStore((s) => s.activeId);
  const remainingOlder = useStore((s) => s.remainingOlder);
  const prependItems = useStore((s) => s.prependItems);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Guards a load-older fetch in flight, and the scroll anchor (distance from
  // bottom) captured at fetch time so the viewport stays put across a prepend.
  const loadingOlderRef = useRef(false);
  const anchorRef = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
  // Coalesces follow-scrolls to at most one per animation frame.
  const followRaf = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Each session starts with autoscroll off (covers switching to an empty
  // session, where the content effect's init branch does not run).
  useEffect(() => {
    followBottom.current = false;
    prevPendingLen.current = 0;
    loadingOlderRef.current = false;
    anchorRef.current = null;
    setLoadingOlder(false);
    setShowScrollBtn(false);
    return () => {
      if (followRaf.current) cancelAnimationFrame(followRaf.current);
      followRaf.current = 0;
    };
  }, [activeId]);

  // Load an older page when the user scrolls near the top. The viewport is
  // anchored to its distance-from-bottom (captured before the fetch) and
  // restored after the prepend renders, so inserting content above does not
  // make the view jump.
  const loadOlder = () => {
    const el = scrollRef.current;
    if (!el || !activeId || loadingOlderRef.current || remainingOlder <= 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const { offset, limit } = olderPageRequest(remainingOlder, 80);
    anchorRef.current = el.scrollHeight - el.scrollTop;
    api
      .transcriptPage(activeId, offset, limit)
      .then((res) => {
        if (res.items.length > 0) {
          prependItems(res.items); // anchor restored in the layout effect
        } else {
          anchorRef.current = null;
          loadingOlderRef.current = false;
          setLoadingOlder(false);
        }
      })
      .catch(() => {
        anchorRef.current = null;
        loadingOlderRef.current = false;
        setLoadingOlder(false);
        useStore.getState().pushToast('Could not load earlier messages.');
      });
  };

  // After a prepend, restore the anchored scroll position before paint.
  useLayoutEffect(() => {
    if (anchorRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchorRef.current;
    anchorRef.current = null;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
  }, [items]);

  const updateScrollBtn = (el: HTMLDivElement) => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distanceFromBottom > 240);
  };

  // Smoothly follow the bottom with a single rAF loop that eases scrollTop
  // toward the bottom itself. Unlike CSS smooth-scroll + repeated scrollIntoView
  // (which restarts an eased animation from a moving target every frame and so
  // pulses down-and-up), this is position-based: each frame it moves a fraction
  // of the remaining distance and only ever downward, so streamed chunks and
  // mid-stream markdown reflow never jerk it. One loop at a time; it stops when
  // caught up and the content effect re-arms it when new content arrives.
  const followTick = () => {
    followRaf.current = 0;
    const el = scrollRef.current;
    if (!el || !followBottom.current) return;
    const target = el.scrollHeight - el.clientHeight;
    const delta = target - el.scrollTop;
    if (delta <= 1 || reduceMotion?.matches) {
      el.scrollTop = target; // snap the final pixel (or all of it) and idle
      lastScrollTop.current = el.scrollTop;
      return;
    }
    el.scrollTop += Math.max(10, Math.ceil(delta * 0.3));
    lastScrollTop.current = el.scrollTop;
    followRaf.current = requestAnimationFrame(followTick);
  };

  const scheduleFollow = () => {
    if (followRaf.current) return; // loop already running
    followRaf.current = requestAnimationFrame(followTick);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // First content for a freshly opened session: jump to the latest message
    // instantly (animating a scroll through the whole history is disorienting),
    // with no follow.
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
    // so their message and the streamed reply smoothly scroll into view.
    if (pending.length > prevPendingLen.current) {
      followBottom.current = true;
    }
    prevPendingLen.current = pending.length;
    if (followBottom.current) {
      scheduleFollow();
    } else {
      updateScrollBtn(el);
    }
  }, [items, streamingText, streamingThought, pending, activeId, compacting]);

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
    // Near the top: pull in the previous page of history. Restoring the anchor
    // pushes the view back down past this threshold, so it won't cascade.
    if (el.scrollTop < 300 && !loadingOlderRef.current && remainingOlder > 0) {
      loadOlder();
    }
  };

  const scrollToBottom = () => {
    followBottom.current = true;
    setShowScrollBtn(false);
    scheduleFollow();
  };

  const empty =
    items.length === 0 && !streamingText && !streamingThought && pending.length === 0;

  return (
    <div className="transcript-wrap">
    {loadingOlder && (
      <div className="loading-older" role="status">
        <Spinner size={14} />
        <span>Loading earlier messages…</span>
      </div>
    )}
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
        ) : item.type === 'tool_call' ? (
          <ToolCallCard key={item.tool.id} tool={item.tool} />
        ) : (
          <CompactionBlock key={item.id} summary={item.summary} />
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

      {compacting && (
        <div className="compaction compaction-live">
          <div className="compaction-rule">
            <span className="compaction-head">
              <Spinner size={13} className="compaction-icon" />
              <span className="compaction-label">Compacting conversation…</span>
            </span>
          </div>
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

/**
 * A durable divider marking where the conversation was compacted. Everything
 * above it was condensed by kiro into the summary shown here (which is what the
 * model now carries as context). Collapsed by default since these summaries are
 * long; click to reveal the full summary.
 */
function CompactionBlock({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="compaction">
      <div className="compaction-rule">
        <button
          className="compaction-head"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <CompressIcon size={14} className="compaction-icon" />
          <span className="compaction-label">Conversation compacted</span>
          <span className="compaction-toggle">{open ? 'Hide summary' : 'Show summary'}</span>
        </button>
      </div>
      {open && (
        <div className="compaction-body">
          <MarkdownRenderer text={summary} />
        </div>
      )}
    </div>
  );
}
