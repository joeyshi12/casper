import { useEffect, useState } from 'react';
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

function ChoiceSteps({ toolCallId, choice }: { toolCallId: string; choice: ChoiceData }) {
  const count = choice.questions.length;
  const [step, setStep] = useState(0);
  // undefined for a question not answered yet, null for one skipped.
  const [answers, setAnswers] = useState<(string | null | undefined)[]>([]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);

  const skipAll = () => {
    if (!busy && sessionController.skipChoice(toolCallId)) setBusy(true);
  };

  const go = (to: number) => {
    if (to < 0 || to >= count) return;
    setStep(to);
    setOther('');
  };

  /** Records the current question's answer, or null to skip it, and moves to the next
   *  unanswered question. Once none is left, the answers go to the call. */
  const settle = (answer: string | null) => {
    if (busy) return;
    const next = [...answers];
    next[step] = answer?.trim() || null;
    setAnswers(next);
    setOther('');
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
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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

  const picked = answers[step];

  return (
    <div className="choice-panel" role="group" aria-label={current.question}>
      <div className="choice-panel-head">
        <p className="choice-panel-q">{current.question}</p>
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
      <ol className="choice-panel-opts">
        {current.options.map((option, i) => (
          <li key={option.label}>
            <button
              className={`choice-panel-opt${picked === option.prompt ? ' is-picked' : ''}`}
              onClick={() => settle(option.prompt)}
              disabled={busy}
              aria-pressed={picked === option.prompt}
            >
              <span className="choice-panel-num">{i + 1}</span>
              <span className="choice-panel-label">{option.label}</span>
              <ArrowUpIcon size={15} className="choice-panel-go" />
            </button>
          </li>
        ))}
        <li className="choice-panel-other">
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
        </li>
      </ol>
    </div>
  );
}
