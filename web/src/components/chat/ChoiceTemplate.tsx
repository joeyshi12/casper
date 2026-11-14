import type { ToolCallView } from '../../state/store.js';
import { choiceAnswerOf, choiceOutcome, choiceSkipped, type ChoiceData } from '../../util/choiceCall.js';

/**
 * A show_choice call in the transcript. While the call is open the options are in the panel
 * above the composer, so this shows nothing. Once answered it shows the answer as the
 * user's message: the option's label, or what they typed.
 */
export function ChoiceTemplate({ data, tool }: { data: ChoiceData; tool: Pick<ToolCallView, 'id' | 'status' | 'content' | 'output'> }) {
  const answer = choiceAnswerOf(tool);
  if (answer !== null) {
    const { picked } = choiceOutcome(data.options, answer);
    return (
      <div className="tpl-choice-reply">
        <div className="msg-user-wrap">
          <div className="msg msg-user">
            <div className="tpl-choice-q">{data.question}</div>
            <div className="msg-user-text">{picked ?? answer}</div>
          </div>
        </div>
      </div>
    );
  }
  if (tool.status === 'in_progress' || tool.status === 'pending') return null;
  return (
    <p className="tpl-choice-closed">
      {choiceSkipped(tool) ? 'Skipped' : 'Not answered'}: {data.question}
    </p>
  );
}
