import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import { api } from '../../api/rest.js';

import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ThoughtLineCard } from './ToolCallCard.js';
import { AttachmentList, TranscriptEntries } from './TranscriptEntries.js';
import { Spinner } from '../common/icons.js';
import {
  TranscriptViewport,
  type ViewportFlags,
} from '../../util/transcriptViewport.js';
import {
  groupToolCalls,
  lastEntryJoinsStreamingThought,
  type GroupedEntry,
} from '../../util/toolGroups.js';

const reduceMotion =
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;


/** Whether this entry, as the last one of a running turn, shows its own shimmer. */
function shimmersWhenLast(entry: GroupedEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.type === 'run' || entry.type === 'thought') return true;
  if (entry.type === 'tool') return entry.tool.status !== 'failed';
  const item = entry.item;
  if (item.type === 'message') return item.message.role === 'thinking';
  return item.type === 'tool_call' && item.tool.status === 'in_progress';
}

export const Transcript = memo(function Transcript() {
  const items = useStore((s) => s.items);
  const streamingText = useStore((s) => s.streamingText);
  const streamingThought = useStore((s) => s.streamingThought);
  const pending = useStore((s) => s.pending);
  const waitingToStart = pending.some((pm) => pm.status === 'sending');
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const compacting = useStore((s) => s.observability.compacting);
  const activeId = useStore((s) => s.activeId);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const remainingOlder = useStore((s) => s.remainingOlder);
  /* Items already on screen when the session opened must not animate, or opening
     an old session flashes every card at once. */
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

  const grouped = useMemo(() => groupToolCalls(items), [items]);

  // The last line of a running turn shimmers, so the dots are only for when nothing does.
  const lastActive = turnStatus === 'running' && !streamingText && pending.length === 0;
  const progressShown =
    (!!streamingThought && pending.length === 0) || (lastActive && shimmersWhenLast(grouped.at(-1)));
  const showDots = (turnStatus === 'running' || waitingToStart) && !streamingText && !progressShown;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [flags, setFlags] = useState<ViewportFlags>({
    loadingOlder: false,
    showScrollButton: false,
  });

  // Holds the scroll state across renders; created once.
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

  // Must run before paint, or a prepend shows as a jump.
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

      <TranscriptEntries
        entries={grouped}
        lastActive={lastActive}
        streamingThought={pending.length === 0 ? streamingThought : ''}
        arrivedLive={arrivedLive}
        chatId={activeId}
        onOpenFile={openFilePreview}
      />

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

      {streamingThought && !lastEntryJoinsStreamingThought(grouped.at(-1)) && pending.length === 0 && (
        <ThoughtLineCard text={streamingThought} live />
      )}

      {streamingText && (
        <div className="msg msg-assistant">
          <MarkdownRenderer text={streamingText} streaming />
        </div>
      )}

      {showDots && (
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
