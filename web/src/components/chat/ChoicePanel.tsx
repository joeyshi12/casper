import { useEffect, useState } from 'react';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import { choiceCallOf } from '../../util/choiceCall.js';
import { CloseIcon, PencilIcon } from '../common/icons.js';

/**
 * The options of the show_choice call the turn is waiting on, above the composer. Tapping an
 * option, or pressing its number, answers the call. "Something else" and the composer below
 * both send a typed answer; Skip and the close button let the turn carry on without one.
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
  const [other, setOther] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    setOther('');
    setSent(null);
  }, [waitingId]);

  const answer = (text: string) => {
    if (!waitingId || sent === waitingId) return;
    if (sessionController.answerChoice(waitingId, text)) setSent(waitingId);
  };
  const skip = () => {
    if (!waitingId || sent === waitingId) return;
    if (sessionController.skipChoice(waitingId)) setSent(waitingId);
  };

  useEffect(() => {
    if (!choice) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choice.options.length) {
        e.preventDefault();
        answer(choice.options[n - 1]!.prompt);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        skip();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!waitingId || !choice) return null;
  const busy = sent === waitingId;

  return (
    <div className="choice-panel" role="group" aria-label={choice.question}>
      <div className="choice-panel-head">
        <p className="choice-panel-q">{choice.question}</p>
        <button className="choice-panel-close" onClick={skip} disabled={busy} title="Skip" aria-label="Skip the question">
          <CloseIcon size={16} />
        </button>
      </div>
      <ol className="choice-panel-opts">
        {choice.options.map((option, i) => (
          <li key={option.label}>
            <button className="choice-panel-opt" onClick={() => answer(option.prompt)} disabled={busy}>
              <span className="choice-panel-num">{i + 1}</span>
              <span className="choice-panel-text">
                <span className="choice-panel-label">{option.label}</span>
                {option.detail && <span className="choice-panel-detail" title={option.detail}>{option.detail}</span>}
              </span>
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
                answer(other);
              }
            }}
            placeholder="Something else"
            aria-label="Something else"
            disabled={busy}
          />
          <button className="choice-panel-skip" onClick={other.trim() ? () => answer(other) : skip} disabled={busy}>
            {other.trim() ? 'Send' : 'Skip'}
          </button>
        </li>
      </ol>
    </div>
  );
}
