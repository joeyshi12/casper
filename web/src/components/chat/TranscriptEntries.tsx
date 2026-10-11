import { useMemo, useState } from 'react';
import type { MessageAttachment, TranscriptItem } from '@casper/shared';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import { api } from '../../api/rest.js';
import { formatSize } from '../../util/formatSize.js';
import { lazyImageProps } from '../../util/lazyImage.js';
import { classifyTurnFailure } from '../../util/turnFailure.js';
import { lastEntryJoinsStreamingThought, type GroupedEntry, type RunMember } from '../../util/toolGroups.js';
import { ChevronIcon, CompressIcon, FileIcon, InterruptedIcon, RefreshIcon, WarningIcon } from '../common/icons.js';
import { Collapse } from './Collapse.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolCallCard, ToolCallGroupCard, ThoughtLineCard, type RunRowInput } from './ToolCallCard.js';

/* The messages, grouped tool calls and thinking of one conversation, shared by the chat
   and by a subagent's row. */
export function TranscriptEntries({
  entries,
  lastActive,
  streamingThought = '',
  arrivedLive = () => false,
  chatId,
  onOpenFile,
  readOnly = false,
}: {
  entries: GroupedEntry[];
  /** The conversation is still running, so its last line shimmers. */
  lastActive: boolean;
  streamingThought?: string;
  arrivedLive?: (toolId: string) => boolean;
  chatId: string | null;
  onOpenFile: (path: string) => void;
  /** A subagent's conversation: nothing in it can be retried. */
  readOnly?: boolean;
}) {
  const rowsByRun = useMemo(() => {
    const map = new Map<GroupedEntry, RunRowInput[]>();
    for (const entry of entries) {
      if (entry.type === 'run') map.set(entry, entry.members.map(runRowOf));
    }
    return map;
  }, [entries]);

  return (
    <>
      {entries.map((entry, i) => {
        const isLast = i === entries.length - 1;
        const active = isLast && lastActive;
        const joiningThought =
          isLast && streamingThought && lastEntryJoinsStreamingThought(entry)
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
          return <ThoughtLineCard key={entry.item.message.id} text={entry.text} live={active} />;
        }
        const item = entry.item;
        return item.type === 'message' ? (
          item.message.role === 'thinking' ? (
            <ThoughtLineCard key={item.message.id} text={item.message.text} live={isLast && lastActive} />
          ) : (
            <div key={item.message.id} className={`msg msg-${item.message.role}`}>
              {item.message.role === 'assistant' ? (
                <MarkdownRenderer text={item.message.text} />
              ) : (
                <>
                  {chatId && item.message.attachments && item.message.attachments.length > 0 && (
                    <AttachmentList
                      chatId={chatId}
                      attachments={item.message.attachments}
                      onOpen={onOpenFile}
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
          <TurnEndCard key={item.id} id={item.id} message={item.message} readOnly={readOnly} />
        ) : item.type === 'turn_interrupted' ? (
          <TurnEndCard key={item.id} id={item.id} readOnly={readOnly} />
        ) : (
          <CompactionBlock key={item.id} summary={item.summary} />
        );
      })}
    </>
  );
}

export function AttachmentList({
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

function runRowOf(member: RunMember): RunRowInput {
  return member.type === 'tool' ? { kind: 'tool', tool: member.tool } : { kind: 'thought', text: member.text };
}

/** Whether the user has written since this card, which ends it as the latest turn. */
function settledAfter(items: TranscriptItem[], pending: number, id: string): boolean {
  if (pending > 0) return true;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if ((it.type === 'turn_error' || it.type === 'turn_interrupted') && it.id === id) return false;
    if (it.type === 'message' && it.message.role === 'user') return true;
  }
  return false;
}

function TurnEndCard({
  id,
  message,
  readOnly = false,
}: {
  id: string;
  /** Present for a failed turn, absent for an interrupted one. */
  message?: string;
  readOnly?: boolean;
}) {
  const failed = message !== undefined;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const failure = failed ? classifyTurnFailure(message) : null;
  const settled = useStore((s) => !readOnly && settledAfter(s.items, s.pending.length, id));
  const lastPrompt = useStore((s) => {
    for (let i = s.items.length - 1; i >= 0; i--) {
      const it = s.items[i]!;
      if (it.type === 'message' && it.message.role === 'user') return it.message.text;
    }
    return '';
  });

  if (settled && !failed) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(message ?? '').then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const canRetry = Boolean(lastPrompt) && !readOnly && !settled;

  return (
    <div className={`turn-end${failed ? ' is-failed' : ''}${settled ? ' is-settled' : ''}`} role="status">
      <div className="turn-end-row">
        <span className="turn-end-icon">
          {failed ? <WarningIcon size={16} /> : <InterruptedIcon size={16} />}
        </span>
        <span className="turn-end-text">{failure ? failure.title : "Casper's response was interrupted"}</span>
        <span className="turn-end-actions">
          {failed && (
            <button className="btn-sm btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? 'Hide details' : 'Details'}
              <span className={`toolline-chevron ${open ? 'is-open' : ''}`}>
                <ChevronIcon size={13} />
              </span>
            </button>
          )}
          {canRetry && (
            <button className="btn-sm" onClick={() => sessionController.retryTurn(lastPrompt)}>
              <RefreshIcon size={13} />
              Retry
            </button>
          )}
        </span>
      </div>
      {failed && (
        <Collapse open={open}>
          <div className="turn-end-body">
            {failure?.fix && <p className="turn-end-fix">{failure.fix}</p>}
            <pre className="turn-end-raw">{message}</pre>
            <button className="btn-sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
        </Collapse>
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
