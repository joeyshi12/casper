import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { sendWidgetPrompt } from '../../state/promptBridge.js';
import type { ChoiceData } from '../../util/choiceCall.js';

/**
 * Read out of the transcript rather than stored: the answer is the next user
 * message, so a reload still shows the choice as made.
 */
function answeredWith(toolId: string, options: ChoiceData['options']): string | null {
  const items = useStore.getState().items;
  const index = items.findIndex((it) => it.type === 'tool_call' && it.tool.id === toolId);
  if (index === -1) return null;
  for (const item of items.slice(index + 1)) {
    if (item.type !== 'message' || item.message.role !== 'user') continue;
    const text = item.message.text.trim();
    const hit = options.find((o) => o.prompt.trim() === text);
    return hit ? hit.label : null;
  }
  return null;
}

export function ChoiceTemplate({ data, toolId }: { data: ChoiceData; toolId: string }) {
  const items = useStore((s) => s.items);
  const [justPicked, setJustPicked] = useState<string | null>(null);
  // items is a dependency in spirit: a new user message can answer this.
  const picked = justPicked ?? (items.length ? answeredWith(toolId, data.options) : null);

  const choose = (option: ChoiceData['options'][number]) => {
    if (picked) return;
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
              disabled={picked !== null}
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
