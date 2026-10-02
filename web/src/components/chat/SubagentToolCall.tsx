import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SubagentSummary, TranscriptItem } from '@casper/shared';
import { useStore, type ToolCallView } from '../../state/store.js';
import { api } from '../../api/rest.js';
import { formatElapsed } from '../../util/duration.js';
import { ChevronIcon } from '../common/icons.js';
import { ToolCallCard } from './ToolCallCard.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { Collapse } from './Collapse.js';

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

  // Fetched on mount, not only when opened, so a call with nothing saved can be hidden.
  const [list, setList] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    fetchSubagents(activeId)
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
  if (list === 'loaded' && subagents.length === 0 && !callRunning) return null;
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
      <Collapse open={open}>
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
          ) : list !== 'failed' && stages.length > 0 ? (
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
                <span className={`agent-what ${list === 'failed' ? '' : 'is-live'}`}>
                  {list === 'failed' ? "Couldn't load the subagents." : 'Loading'}
                </span>
              </div>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

// Several subagent calls in one chat share one request for the chat's list.
const inflight = new Map<string, ReturnType<typeof api.subagents>>();
function fetchSubagents(chatId: string): ReturnType<typeof api.subagents> {
  let p = inflight.get(chatId);
  if (!p) {
    p = api.subagents(chatId).finally(() => inflight.delete(chatId));
    inflight.set(chatId, p);
  }
  return p;
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
      <Collapse open={open}>
        <div className="agent-detail">
          {chatId && (
            <SubagentTranscript
              chatId={chatId}
              subagentId={subagent.sessionId}
              live={live}
              elapsed={formatElapsed(elapsed)}
            />
          )}
        </div>
      </Collapse>
    </div>
  );
}

// How many of the latest steps an opened row shows, and how many more each click adds.
const TAIL = 6;
const PAGE = 40;
// A running subagent's transcript is fetched again this often while its row is open.
const POLL_MS = 3000;

type Step =
  | { kind: 'tool'; id: string; tool: ToolCallView }
  | { kind: 'say'; id: string; text: string }
  | { kind: 'error'; id: string; text: string };

/** One line per message and tool call, in order. The prompt and thinking are left out. */
export function subagentSteps(items: TranscriptItem[]): Step[] {
  const out: Step[] = [];
  for (const it of items) {
    if (it.type === 'tool_call') out.push({ kind: 'tool', id: it.tool.id, tool: it.tool });
    else if (it.type === 'message' && it.message.role === 'assistant' && it.message.text.trim()) {
      out.push({ kind: 'say', id: it.message.id, text: it.message.text });
    } else if (it.type === 'turn_error') out.push({ kind: 'error', id: it.id, text: it.message });
  }
  return out;
}

function totals(steps: Step[]): string {
  const messages = steps.filter((x) => x.kind === 'say').length;
  const tools = steps.filter((x) => x.kind === 'tool').length;
  const m = messages === 1 ? '1 message' : `${messages} messages`;
  const t = tools === 1 ? '1 tool call' : `${tools} tool calls`;
  return `${m} and ${t}`;
}

/* A subagent's answer, then its steps as one-line entries. While it runs, the latest steps
   show at once and the row keeps the same height as new ones arrive. */
function SubagentTranscript({
  chatId,
  subagentId,
  live,
  elapsed,
}: {
  chatId: string;
  subagentId: string;
  live: boolean;
  elapsed: string;
}) {
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [error, setError] = useState(false);
  // null until the user opens or closes the steps: then they follow whether it is running.
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const [shown, setShown] = useState(TAIL);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .subagentDetail(chatId, subagentId)
        .then((r) => {
          if (alive) setItems(r.transcript);
        })
        .catch(() => {
          if (alive) setError(true);
        });
    void load();
    if (!live) return () => void (alive = false);
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [chatId, subagentId, live]);

  const all = useMemo(() => subagentSteps(items ?? []), [items]);

  if (error) return <div className="agent-note">Couldn't load this subagent's transcript.</div>;
  if (items === null) return <div className="agent-note">Loading…</div>;

  const last = all.at(-1);
  const answer = !live && last?.kind === 'say' ? last : undefined;
  const steps = answer ? all.slice(0, -1) : all;
  const open = stepsOpen ?? live;
  const visible = steps.slice(-shown);
  const hidden = steps.length - visible.length;

  return (
    <div className="agent-transcript">
      {answer && (
        <div className="msg msg-assistant">
          <MarkdownRenderer text={answer.text} />
        </div>
      )}
      {steps.length > 0 && (
        <div>
          <button className="toolline" onClick={() => setStepsOpen(!open)} aria-expanded={open}>
            <span className="toolline-text">
              {totals(all)} {live ? 'so far' : `over ${elapsed}`}
            </span>
            <span className={`toolline-chevron ${open ? 'is-open' : ''}`}>
              <ChevronIcon size={13} />
            </span>
          </button>
          <Collapse open={open}>
            <div className={`agent-steps ${shown > TAIL ? 'is-paged' : ''}`}>
              {hidden > 0 && (
                <button
                  className="agent-earlier"
                  onClick={() => {
                    setStepsOpen(true);
                    setShown((n) => n + PAGE);
                  }}
                >
                  Show {Math.min(PAGE, hidden)} earlier of {hidden}
                </button>
              )}
              {visible.map((step): ReactNode =>
                step.kind === 'tool' ? (
                  <ToolCallCard key={step.id} tool={step.tool} />
                ) : step.kind === 'say' ? (
                  <SubagentMessage key={step.id} text={step.text} />
                ) : (
                  <div key={step.id} className="agent-note is-failed">
                    {step.text}
                  </div>
                ),
              )}
            </div>
          </Collapse>
        </div>
      )}
    </div>
  );
}

/** A message between tool calls: one line, opening to the whole text. */
function SubagentMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className={`agent-say ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
      {text}
    </button>
  );
}

export const SubagentToolCall = memo(SubagentToolCallBody);
