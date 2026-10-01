import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SubagentSummary, TranscriptItem } from '@casper/shared';
import { useStore, type ToolCallView } from '../../state/store.js';
import { api } from '../../api/rest.js';
import { groupToolCalls } from '../../util/toolGroups.js';
import { formatElapsed } from '../../util/duration.js';
import { ChevronIcon } from '../common/icons.js';
import { ToolCallCard, ToolCallGroupCard } from './ToolCallCard.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

interface StageInput {
  name: string;
}

function stagesOf(tool: ToolCallView): StageInput[] {
  const input = tool.input as { stages?: unknown } | undefined;
  if (!input || !Array.isArray(input.stages)) return [];
  return input.stages.filter(
    (s): s is StageInput => typeof s === 'object' && s !== null && typeof (s as StageInput).name === 'string',
  );
}

export function elapsedSeconds(subagent: Pick<SubagentSummary, 'status' | 'createdAt' | 'updatedAt'>): number {
  if (!subagent.createdAt) return 0;
  const end = subagent.status === 'working' || !subagent.updatedAt ? Date.now() : new Date(subagent.updatedAt).getTime();
  const ms = end - new Date(subagent.createdAt).getTime();
  return ms > 0 ? ms / 1000 : 0;
}

function pipelineLine(subagents: SubagentSummary[], running: boolean): string {
  const done = subagents.filter((s) => s.status === 'completed' || s.status === 'failed').length;
  const n = subagents.length;
  if (!running) return n === 1 ? 'Ran 1 subagent' : `Ran ${n} subagents`;
  const noun = n === 1 ? 'subagent' : 'subagents';
  return `Running ${n} ${noun}, ${done} done`;
}

function SubagentToolCallBody({ tool }: { tool: ToolCallView }) {
  const activeId = useStore((s) => s.activeId);
  const allSubagents = useStore((s) => s.subagents);
  const setSubagents = useStore((s) => s.setSubagents);

  const stages = useMemo(() => stagesOf(tool), [tool]);
  const subagents = useMemo(
    () => allSubagents.filter((a) => a.toolCallId === tool.id),
    [allSubagents, tool.id],
  );
  const running = subagents.some((a) => a.status === 'working' || a.status === 'pending');
  const [open, setOpen] = useState(tool.status === 'in_progress' || running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const [list, setList] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    if (!open || !activeId) return;
    let alive = true;
    api
      .subagents(activeId)
      .then((r) => {
        if (!alive) return;
        setSubagents(r.subagents);
        setList('loaded');
      })
      .catch(() => {
        if (alive) setList('failed');
      });
    return () => {
      alive = false;
    };
  }, [open, activeId, setSubagents]);

  const [openRow, setOpenRow] = useState<string | null>(null);

  const callRunning = tool.status === 'in_progress';
  const text =
    subagents.length > 0
      ? pipelineLine(subagents, running)
      : stages.length > 0
        ? pipelineLine(
            stages.map((s) => ({
              sessionId: s.name,
              stageName: s.name,
              status: callRunning ? 'pending' : 'completed',
              createdAt: '',
              updatedAt: '',
            })),
            callRunning,
          )
        : callRunning
          ? 'Running subagents'
          : 'Ran subagents';

  return (
    <div className="toolline-wrap">
      <button className="toolline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`toolline-text ${running ? 'is-live' : ''}`}>{text}</span>
        <span className={`toolline-chevron ${open ? 'is-open' : ''}`}>
          <ChevronIcon size={13} />
        </span>
      </button>
      {open && (
        <div className="toolline-box">
          {subagents.length > 0 ? (
            subagents.map((a) => (
              <SubagentRow
                key={a.sessionId}
                chatId={activeId}
                subagent={a}
                open={openRow === a.sessionId}
                onToggle={() => setOpenRow((cur) => (cur === a.sessionId ? null : a.sessionId))}
              />
            ))
          ) : list === 'loading' && stages.length > 0 ? (
            stages.map((st) => (
              <div key={st.name} className="toolline-row">
                <div className="agent-row">
                  <span className="agent-dot" />
                  <span className="agent-name">{st.name}</span>
                  <span className="agent-what is-live">Loading</span>
                </div>
              </div>
            ))
          ) : (
            <div className="toolline-row">
              <div className="agent-row">
                <span className={`agent-what ${list === 'loading' ? 'is-live' : ''}`}>
                  {list === 'loading'
                    ? 'Loading'
                    : list === 'failed'
                      ? "Couldn't load the subagents."
                      : 'No details were saved for these subagents.'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function rowActivity(a: SubagentSummary): string {
  if (a.status === 'completed') return 'Done';
  if (a.status === 'failed') return a.activity ?? 'Failed';
  return a.activity ?? 'Working';
}

function SubagentRow({
  chatId,
  subagent,
  open,
  onToggle,
}: {
  chatId: string | null;
  subagent: SubagentSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const live = subagent.status === 'working';
  const [elapsed, setElapsed] = useState(() => elapsedSeconds(subagent));
  useEffect(() => {
    setElapsed(elapsedSeconds(subagent));
    if (!live) return;
    const id = setInterval(() => setElapsed(elapsedSeconds(subagent)), 1000);
    return () => clearInterval(id);
  }, [live, subagent]);

  return (
    <div className="toolline-row">
      <button className="agent-row" onClick={onToggle} aria-expanded={open}>
        <span className={`agent-dot agent-dot-${subagent.status}`} />
        <span className="agent-name">{subagent.stageName}</span>
        <span className={`agent-what ${live ? 'is-live' : ''}`}>{rowActivity(subagent)}</span>
        <span className="agent-time">{subagent.status === 'pending' ? '' : formatElapsed(elapsed)}</span>
      </button>
      {open && (
        <div className="agent-detail">
          {chatId && (
            <SubagentTranscript chatId={chatId} subagentId={subagent.sessionId} live={live} />
          )}
        </div>
      )}
    </div>
  );
}

function SubagentTranscript({
  chatId,
  subagentId,
  live,
}: {
  chatId: string;
  subagentId: string;
  live: boolean;
}) {
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(false);
    api
      .subagentDetail(chatId, subagentId)
      .then((r) => {
        if (alive) setItems(r.transcript);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [chatId, subagentId, live]);

  const grouped = useMemo(() => groupToolCalls(items ?? []), [items]);

  if (error) return <div className="agent-note">Couldn't load this subagent's transcript.</div>;
  if (items === null) return <div className="agent-note">Loading…</div>;
  if (items.length === 0) return null;

  return (
    <div className="agent-transcript">
      {grouped.map((entry): ReactNode => {
        if (entry.type === 'run') {
          const toolMembers = entry.members.filter((m) => m.type === 'tool');
          if (toolMembers.length === 0) return null;
          if (toolMembers.length === 1) {
            return <ToolCallCard key={toolMembers[0]!.tool.id} tool={toolMembers[0]!.tool} />;
          }
          const key = toolMembers.map((m) => m.tool.id).join('-');
          return (
            <ToolCallGroupCard key={key} rows={toolMembers.map((m) => ({ kind: 'tool' as const, tool: m.tool }))} />
          );
        }
        if (entry.type === 'thought') return null;
        if (entry.type === 'tool') {
          return <ToolCallCard key={entry.tool.id} tool={entry.tool} />;
        }
        const item = entry.item;
        if (item.type === 'message') {
          if (item.message.role === 'thinking') return null;
          return (
            <div key={item.message.id} className={`msg msg-${item.message.role}`}>
              {item.message.role === 'assistant' ? (
                <MarkdownRenderer text={item.message.text} />
              ) : (
                <div className="msg-user-text">{item.message.text}</div>
              )}
            </div>
          );
        }
        if (item.type === 'turn_error') {
          return (
            <div key={item.id} className="agent-note is-failed">
              {item.message}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export const SubagentToolCall = memo(SubagentToolCallBody);
