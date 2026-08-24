import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import type { MessageAttachment } from '@casper/shared';
import { api } from '../../api/rest.js';
import { formatSize } from '../../util/formatSize.js';
import { FileIcon } from '../common/icons.js';

import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard } from './ToolCallCard.js';
import { CompressIcon, Spinner, WarningIcon } from '../common/icons.js';
import { lazyImageProps } from '../../util/lazyImage.js';
import {
  TranscriptViewport,
  type ViewportFlags,
} from '../../util/transcriptViewport.js';
import { classifyTurnFailure } from '../../util/turnFailure.js';
import { ChevronIcon } from '../common/icons.js';

/** How long a running turn may be quiet before the dots come back. */
const STALL_MS = 700;

const reduceMotion =
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

/**
 * The files attached to one message: images as thumbnails, anything else a chip that opens
 * the preview panel. Shared by the sent message and the optimistic bubble.
 */
function AttachmentList({
  chatId,
  attachments,
  onOpen,
}: {
  chatId: string;
  attachments: MessageAttachment[];
  onOpen: (path: string) => void;
}) {
  return (
    <div className="msg-attachments">
      {attachments.map((a) =>
        a.kind === 'image' ? (
          <a
            key={a.path}
            href={api.previewUrl(chatId, a.path)}
            target="_blank"
            rel="noopener noreferrer"
            className="msg-image-link"
          >
            <img
              src={api.previewUrl(chatId, a.path)}
              alt={a.name}
              className="msg-image"
              {...lazyImageProps}
            />
          </a>
        ) : (
          <button
            key={a.path}
            type="button"
            className="msg-file"
            title={a.path}
            onClick={() => onOpen(a.path)}
          >
            <FileIcon size={14} />
            <span className="msg-file-name">{a.name}</span>
            <span className="msg-file-size">{formatSize(a.size)}</span>
          </button>
        ),
      )}
    </div>
  );
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
export const Transcript = memo(function Transcript() {
  const items = useStore((s) => s.items);
  const streamingText = useStore((s) => s.streamingText);
  const streamingThought = useStore((s) => s.streamingThought);
  const pending = useStore((s) => s.pending);
  // A prompt that has left the composer but has no turn yet: a draft is still creating its
  // session, or its socket is still opening. The dots say the app is working on it.
  const waitingToStart = pending.some((pm) => pm.status === 'sending');
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const compacting = useStore((s) => s.observability.compacting);
  const activeId = useStore((s) => s.activeId);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const remainingOlder = useStore((s) => s.remainingOlder);
  // Items already on screen when a session opened must not animate, or opening an old session
  // flashes every card at once. Anything not in this set arrived live.
  const hydrated = useRef<{ session: string | null; ids: Set<string> }>({
    session: null,
    ids: new Set(),
  });
  if (hydrated.current.session !== activeId) {
    hydrated.current = {
      session: activeId,
        ids: new Set(
        items.filter((it) => it.type === 'tool_call').map((it) => it.tool.id),
      ),
    };
  }
  const arrivedLive = (id: string) => !hydrated.current.ids.has(id);

  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (turnStatus !== 'running') return;
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [turnStatus, streamingText, streamingThought, items.length]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [flags, setFlags] = useState<ViewportFlags>({
    loadingOlder: false,
    showScrollButton: false,
  });

  // Follow, anchoring across a prepend, and older-page loading are one concern and
  // live in the viewport. Created once: it holds the scroll state across renders.
  const viewportRef = useRef<TranscriptViewport | null>(null);
  if (!viewportRef.current) {
    viewportRef.current = new TranscriptViewport({
      element: () => scrollRef.current,
      fetchPage: (chatId, offset, limit) =>
        api.transcriptPage(chatId, offset, limit).then((r) => r.items),
      prepend: (older) => useStore.getState().prependItems(older),
      onFlags: setFlags,
      reducedMotion: () => reduceMotion?.matches ?? false,
    });
  }
  const viewport = viewportRef.current;

  useEffect(() => {
    viewport.reset();
    return () => viewport.dispose();
  }, [activeId, viewport]);

  useEffect(() => {
    viewport.onContent({
      chatId: activeId,
      itemCount: items.length,
      pendingCount: pending.length,
      remainingOlder,
    });
  }, [items, streamingText, streamingThought, pending, activeId, compacting, remainingOlder, viewport]);

  // Before paint, so a prepend never shows as a jump.
  useLayoutEffect(() => {
    viewport.restoreAnchor();
  }, [items, viewport]);

  const empty =
    items.length === 0 && !streamingText && !streamingThought && pending.length === 0;

  return (
    <div className="transcript-wrap">
    {flags.loadingOlder && (
      <div className="loading-older" role="status">
        <Spinner size={14} />
        <span>Loading earlier messages…</span>
      </div>
    )}
    <div className="transcript" ref={scrollRef} onScroll={() => viewport.onScroll()}>
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
                  {activeId && item.message.attachments && item.message.attachments.length > 0 && (
                    <AttachmentList
                      chatId={activeId}
                      attachments={item.message.attachments}
                      onOpen={openFilePreview}
                    />
                  )}
                  {item.message.text && (
                    <div className="msg-user-text">{item.message.text}</div>
                  )}
                </>
              )}
            </div>
          )
        ) : item.type === 'tool_call' ? (
          <ToolCallCard key={item.tool.id} tool={item.tool} arriving={arrivedLive(item.tool.id)} />
        ) : item.type === 'turn_error' ? (
          <TurnErrorBlock key={item.id} message={item.message} />
        ) : (
          <CompactionBlock key={item.id} summary={item.summary} />
        ),
      )}

      {pending.map((pm) => (
        <div
          key={pm.id}
          className={`msg msg-user msg-pending ${pm.status === 'failed' ? 'is-failed' : ''}`}
        >
          {activeId && pm.attachments && pm.attachments.length > 0 && (
            <AttachmentList chatId={activeId} attachments={pm.attachments} onOpen={openFilePreview} />
          )}
          {pm.text && <div className="msg-user-text">{pm.text}</div>}
          {pm.status === 'failed' && (
            <div className="msg-failed">
              <span className="msg-failed-why">{pm.error ?? 'Failed to send.'}</span>
              <button className="msg-retry" onClick={() => sessionController.retrySend(pm.id)}>
                Retry
              </button>
            </div>
          )}
        </div>
      ))}

      {streamingThought && <ThoughtBlock text={streamingThought} live />}

      {streamingText && (
        <div className="msg msg-assistant">
          <MarkdownRenderer text={streamingText} streaming />
        </div>
      )}

      {(turnStatus === 'running' || waitingToStart) &&
          (stalled || (!streamingText && !streamingThought)) && (
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

    </div>
      {flags.showScrollButton && (
        <button
          className="scroll-to-bottom"
          onClick={() => viewport.jumpToLatest()}
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
 * A collapsible reasoning block, dimmed and distinct from spoken output, and collapsed
 * whether or not it is still being written.
 */
function ThoughtBlock({ text, live = false }: { text: string; live?: boolean }) {
  // Collapsed even while being written: the shimmer says it is working.
  const [open, setOpen] = useState(false);
  return (
    <div className={`thought ${live ? 'is-live' : ''}`}>
      <button className="thought-head" onClick={() => setOpen((o) => !o)}>
        <span className={`thought-chevron ${open ? 'is-open' : ''}`}>
          <ChevronIcon size={13} />
        </span>
        <span className={`thought-label ${live ? 'is-live' : ''}`}>Thinking</span>
      </button>
      {open && (
        <div className="thought-body">
          {/* Plain text, not markdown: the body mounts whole, so a code fence in it would
              render uncoloured and then recolour when the highlighter answers. */}
          <div className="thought-text">{text}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Divider marking where kiro compacted the conversation. The summary shown is what the
 * model now carries as context, collapsed by default because these run long.
 */
/**
 * A failed turn, shown as a system event rather than something the assistant said. One
 * line by default, borrowing the compaction divider's shape, expanding to the cause,
 * what to do about it, and the server's raw output.
 */
function TurnErrorBlock({
  message,
}: {
  message: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const failure = classifyTurnFailure(message);
  const lastPrompt = useStore((s) => {
    // The prompt that produced this failure, so Retry can send it again.
    for (let i = s.items.length - 1; i >= 0; i--) {
      const it = s.items[i]!;
      if (it.type === 'message' && it.message.role === 'user') return it.message.text;
    }
    return '';
  });

  const copy = () => {
    void navigator.clipboard?.writeText(message).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="sysnote">
      <div className="sysnote-rule">
        <button
          className="sysnote-head"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <WarningIcon size={13} />
          <span className="sysnote-label">{failure.title}</span>
          <span className="sysnote-toggle">{open ? 'Hide details' : 'Show details'}</span>
        </button>
      </div>

      {open && (
        <div className="sysnote-body">
          {failure.fix && <p className="sysnote-fix">{failure.fix}</p>}
          <pre className="sysnote-raw">{message}</pre>
          <div className="sysnote-actions">
            {lastPrompt && (
              <button className="btn-sm is-danger" onClick={() => sessionController.retryTurn(lastPrompt)}>
                Retry turn
              </button>
            )}
            <button className="btn-sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
