import type { ToolCallView } from '../../state/store.js';
import { answerLabel, choiceResultOf, type ChoiceData } from '../../util/choiceCall.js';

/**
 * A show_choice call in the transcript. While the call is open its questions are in the panel
 * above the composer, so this shows nothing. Afterwards it shows each question with the answer
 * given, or the reply typed instead.
 */
export function ChoiceTemplate({ data, tool }: { data: ChoiceData; tool: Pick<ToolCallView, 'status' | 'content' | 'output'> }) {
  if (tool.status === 'in_progress' || tool.status === 'pending') return null;
  const result = choiceResultOf(tool, data);
  const rows =
    result?.kind === 'reply'
      ? [{ question: data.questions.map((q) => q.question).join(' '), answer: result.text, muted: false }]
      : data.questions.map((q, i) => {
          const answer = result?.kind === 'answers' ? result.answers[i] : null;
          if (answer) return { question: q.question, answer: answerLabel(q, answer), muted: false };
          return { question: q.question, answer: result ? 'Skipped' : 'Not answered', muted: true };
        });
  return (
    <div className="tpl-choice-record">
      {rows.map((row, i) => (
        <div key={i} className="tpl-choice-row">
          <div className="tpl-choice-q">{row.question}</div>
          <div className={`tpl-choice-a${row.muted ? ' is-muted' : ''}`}>{row.answer}</div>
        </div>
      ))}
    </div>
  );
}
