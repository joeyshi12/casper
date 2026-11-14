import { useEffect, useRef, useState } from 'react';
import { encodeChoiceAnswers, type ChoiceAnswers } from '@casper/shared';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import { choiceCallOf, type ChoiceData } from '../../util/choiceCall.js';
import { ArrowUpIcon, ChevronRightIcon, CloseIcon, PencilIcon } from '../common/icons.js';

/**
 * The questions of the show_choice call the turn is waiting on, above the composer, asked
 * one at a time. Tapping an option, or pressing its number, answers the current question;
 * "Something else" answers it with typed text, and Skip passes over it. The arrows, or the
 * arrow keys, move between questions. The answers go to the call together once every
 * question has one. The close button skips them all, and a message
 * sent from the composer answers the call in their place.
 */
export function ChoicePanel() {
  const waitingId = useStore((s) => s.observability.waitingChoice);
  const tool = useStore((s) => {
    if (!waitingId) return null;
    for (let i = s.items.length - 1; i >= 0; i--) {
      const it = s.items[i]!;
      if (it.type === 'tool_call' && it.tool.id === waitingId) return it.tool;
    }
    return null;
  });
  const choice = tool ? choiceCallOf(tool) : null;
  // Keyed by the call, so a new call starts on its first question with nothing answered.
  return waitingId && choice ? <ChoiceSteps key={waitingId} toolCallId={waitingId} choice={choice} /> : null;
}

/** Whether the panel's keys should act: nothing else has the keyboard, and no dialog, menu or
 *  list is open whose own keys (Escape, digits, arrows) would also reach this panel. */
function panelHasKeys(panel: HTMLElement | null, e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const active = document.activeElement;
  if (active && active !== document.body && !panel?.contains(active)) return false;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return false;
  return !document.querySelector('[role="dialog"], [role="listbox"], [role="menu"]');
}

function ChoiceSteps({ toolCallId, choice }: { toolCallId: string; choice: ChoiceData }) {
  const count = choice.questions.length;
  const panelRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  // undefined for a question not answered yet, null for one skipped.
  const [answers, setAnswers] = useState<(string | null | undefined)[]>([]);
  // What is typed in "Something else", per question, so moving between them keeps it.
  const [drafts, setDrafts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const other = drafts[step] ?? '';
  const setOther = (text: string) => setDrafts((d) => Object.assign([...d], { [step]: text }));

  const skipAll = () => {
    if (!busy && sessionController.skipChoice(toolCallId)) setBusy(true);
  };

  const go = (to: number) => {
    if (to >= 0 && to < count) setStep(to);
  };

  /** Records the current question's answer, or null to skip it, and moves to the next
   *  unanswered question. Once none is left, the answers go to the call. */
  const settle = (answer: string | null) => {
    if (busy) return;
    const next = [...answers];
    next[step] = answer?.trim() || null;
    setAnswers(next);
    const after = [...Array(count).keys()].map((i) => (step + 1 + i) % count);
    const open = after.find((i) => next[i] === undefined);
    if (open !== undefined) {
      setStep(open);
      return;
    }
    const final: ChoiceAnswers = next.map((a) => a ?? null);
    const sent = final.every((a) => a === null)
      ? sessionController.skipChoice(toolCallId)
      : sessionController.answerChoice(toolCallId, encodeChoiceAnswers(final));
    if (sent) setBusy(true);
  };

  const current = choice.questions[step]!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!panelHasKeys(panelRef.current, e)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= current.options.length) {
        e.preventDefault();
        settle(current.options[n - 1]!.prompt);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        settle(null);
      } else if (count > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        go(step + (e.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Every question is rendered in the same grid cell and only the current one is visible, so
  // the panel is as tall as its tallest question and does not change height between them.
  return (
    <div className="choice-panel" role="group" aria-label={current.question} ref={panelRef}>
      <div className="choice-panel-head">
        <div className="choice-panel-stack">
          {choice.questions.map((q, i) => (
            <p key={i} className={`choice-panel-q${i === step ? ' is-current' : ''}`}>
              {q.question}
            </p>
          ))}
        </div>
        {count > 1 && (
          <div className="choice-panel-nav">
            <button className="choice-panel-icon" onClick={() => go(step - 1)} disabled={step === 0} aria-label="Previous question">
              <ChevronRightIcon size={16} className="is-flipped" />
            </button>
            <span className="choice-panel-step">
              {step + 1} of {count}
            </span>
            <button className="choice-panel-icon" onClick={() => go(step + 1)} disabled={step === count - 1} aria-label="Next question">
              <ChevronRightIcon size={16} />
            </button>
          </div>
        )}
        <button className="choice-panel-icon" onClick={skipAll} disabled={busy} title="Skip" aria-label="Skip the questions">
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="choice-panel-stack">
        {choice.questions.map((q, qi) => (
          <ol key={qi} className={`choice-panel-opts${qi === step ? ' is-current' : ''}`}>
            {q.options.map((option, i) => {
              const picked = answers[qi] === option.prompt;
              return (
                <li key={i}>
                  <button
                    className={`choice-panel-opt${picked ? ' is-picked' : ''}`}
                    onClick={() => settle(option.prompt)}
                    disabled={busy}
                    aria-pressed={picked}
                  >
                    <span className="choice-panel-num">{i + 1}</span>
                    <span className="choice-panel-label">{option.label}</span>
                    <ArrowUpIcon size={15} className="choice-panel-go" />
                  </button>
                </li>
              );
            })}
          </ol>
        ))}
      </div>
      <div className="choice-panel-other">
        <span className="choice-panel-num">
          <PencilIcon size={14} />
        </span>
        <input
          className="choice-panel-input"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && other.trim()) {
              e.preventDefault();
              settle(other);
            }
          }}
          placeholder="Something else"
          aria-label="Something else"
          disabled={busy}
        />
        <button className="choice-panel-skip" onClick={() => settle(other.trim() ? other : null)} disabled={busy}>
          {other.trim() ? 'Send' : 'Skip'}
        </button>
      </div>
    </div>
  );
}
