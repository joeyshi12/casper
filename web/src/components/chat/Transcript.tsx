import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import type { MessageAttachment } from '@casper/shared';
import { api } from '../../api/rest.js';
import { formatSize } from '../../util/formatSize.js';
import { FileIcon } from '../common/icons.js';

import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard, ToolCallGroupCard, ThoughtLineCard, type RunRowInput } from './ToolCallCard.js';
import { CompressIcon, Spinner, WarningIcon } from '../common/icons.js';
import { lazyImageProps } from '../../util/lazyImage.js';
import {
  TranscriptViewport,
  type ViewportFlags,
} from '../../util/transcriptViewport.js';
import { classifyTurnFailure } from '../../util/turnFailure.js';
import {
  groupToolCalls,
  lastEntryJoinsStreamingThought,
  type GroupedEntry,
  type RunMember,
} from '../../util/toolGroups.js';

const STALL_MS = 700;

const reduceMotion =
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

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
  const rowsByRun = useMemo(() => {
    const map = new Map<GroupedEntry, RunRowInput[]>();
    for (const entry of grouped) {
      if (entry.type === 'run') map.set(entry, entry.members.map(runRowOf));
    }
    return map;
  }, [grouped]);

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

      {grouped.map((entry, i) => {
        const isLast = i === grouped.length - 1;
        const active = isLast && turnStatus === 'running' && !streamingText && pending.length === 0;
        const joiningThought =
          isLast && streamingThought && pending.length === 0 && lastEntryJoinsStreamingThought(entry)
            ? streamingThought
            : undefined;

        if (entry.type === 'run') {
          // Keyed by the first member, so a row joining the run keeps it mounted.
          const first = entry.members[0]!;
          const key = first.type === 'tool' ? first.tool.id : first.item.message.id;
          const arriving = entry.members.some(
            (m) => m.type === 'tool' && arrivedLive(m.tool.id),
          );
          return (
            <ToolCallGroupCard
              key={key}
              rows={rowsByRun.get(entry)!}
              liveThought={joiningThought}
              arriving={arriving}
              active={active}
            />
          );
        }
        if (entry.type === 'tool') {
          if (joiningThought !== undefined) {
            return (
              <ToolCallGroupCard
                key={entry.tool.id}
                rows={[runRowOf(entry)]}
                liveThought={joiningThought}
                arriving={arrivedLive(entry.tool.id)}
                active={active}
              />
            );
          }
          return (
            <ToolCallCard
              key={entry.tool.id}
              tool={entry.tool}
              arriving={arrivedLive(entry.tool.id)}
              active={active}
            />
          );
        }
        if (entry.type === 'thought') {
          if (joiningThought !== undefined) {
            return (
              <ToolCallGroupCard
                key={entry.item.message.id}
                rows={[runRowOf(entry)]}
                liveThought={joiningThought}
              />
            );
          }
          return <ThoughtLineCard key={entry.item.message.id} text={entry.text} />;
        }
        const item = entry.item;
        return item.type === 'message' ? (
          item.message.role === 'thinking' ? (
            <ThoughtLineCard key={item.message.id} text={item.message.text} />
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
        );
      })}

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

function runRowOf(member: RunMember): RunRowInput {
  return member.type === 'tool' ? { kind: 'tool', tool: member.tool } : { kind: 'thought', text: member.text };
}

function TurnErrorBlock({
  message,
}: {
  message: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const failure = classifyTurnFailure(message);
  const lastPrompt = useStore((s) => {
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
