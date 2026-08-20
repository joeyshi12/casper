import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { sendWidgetPrompt } from '../../state/sessionController.js';
import { choiceOutcome, type ChoiceData } from '../../util/choiceCall.js';

/**
 * The first thing the user said after the choice appeared, read out of the transcript rather
 * than stored, so a reload still shows what became of it. A message still in flight counts:
 * it is the newest thing said, whether it came from a button or the composer.
 */
function replyAfter(toolId: string): string | null {
  const { items, pending } = useStore.getState();
  const index = items.findIndex((it) => it.type === 'tool_call' && it.tool.id === toolId);
  if (index === -1) return null;
  for (const item of items.slice(index + 1)) {
    if (item.type === 'message' && item.message.role === 'user') return item.message.text;
  }
  return pending[0]?.text ?? null;
}

export function ChoiceTemplate({ data, toolId }: { data: ChoiceData; toolId: string }) {
  // Subscribed so a new message - typed or sent by a button - re-evaluates the outcome.
  const items = useStore((s) => s.items);
  const pending = useStore((s) => s.pending);
  const [justPicked, setJustPicked] = useState<string | null>(null);

  const outcome = choiceOutcome(
    data.options,
    items.length || pending.length ? replyAfter(toolId) : null,
  );
  const picked = justPicked ?? outcome.picked;
  const closed = picked !== null || outcome.superseded;

  const choose = (option: ChoiceData['options'][number]) => {
    if (closed) return;
    if (sendWidgetPrompt(option.prompt)) setJustPicked(option.label);
  };

  return (
    <div className="tpl-choice">
      <p className="tpl-choice-q">{data.question}</p>
      <div className="tpl-choice-opts">
        {data.options.map((option) => {
          const isPicked = picked === option.label;
          return (
            <button
              key={option.label}
              className={`tpl-choice-opt${isPicked ? ' is-picked' : ''}`}
              onClick={() => choose(option)}
              disabled={closed}
              aria-pressed={isPicked}
            >
              <span className="tpl-choice-label">{option.label}</span>
              {option.detail && <span className="tpl-choice-detail">{option.detail}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
