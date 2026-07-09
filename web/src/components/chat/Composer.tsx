import { useState } from 'react';
import { useStore } from '../../state/store.js';

interface Props {
  onSend: (text: string) => void;
  onCancel: () => void;
  /** True once the session's socket is connected and ready to accept prompts. */
  live: boolean;
}

/** Mobile-first message input. Shows Send when idle, Stop while a turn runs. */
export function Composer({ onSend, onCancel, live }: Props) {
  const [text, setText] = useState('');
  const running = useStore((s) => s.observability.turnStatus === 'running');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || running || !live) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter sends; Shift+Enter newline. On touch, the Send button is primary.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = !live
    ? 'Connecting…'
    : running
      ? 'Casper is working…'
      : 'Ask Casper to build something…';

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={1}
      />
      {running ? (
        <button className="composer-btn composer-stop" onClick={onCancel}>
          Stop
        </button>
      ) : (
        <button
          className="composer-btn composer-send"
          onClick={submit}
          disabled={!text.trim() || !live}
        >
          Send
        </button>
      )}
    </div>
  );
}
