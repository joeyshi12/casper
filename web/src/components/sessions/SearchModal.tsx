import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSummary } from '@casper/shared';
import { fuzzyScore } from '../../util/fuzzy.js';
import { sessionController } from '../../state/sessionController.js';
import { SearchIcon } from '../common/icons.js';

interface Props {
  sessions: ChatSummary[];
  onOpen: (id: string) => void;
  onClose: () => void;
}

/**
 * Centered fuzzy-search palette with a shadow backdrop, like the Claude web
 * app. Type to filter sessions; ↑/↓ to move, Enter to open, Esc to close.
 */
export function SearchModal({ sessions, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return sessions.slice(0, 50);
    return sessions
      .map((s) => ({ s, score: fuzzyScore(query, s.title) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }, [sessions, query]);

  // Reset the keyboard selection to the top result whenever the query changes.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // A result is a button, not a link, so onOpen alone navigates nowhere.
  const choose = (id: string) => {
    onOpen(id);
    sessionController.goToChat(id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) choose(hit.chatId);
    }
  };

  // Rendered at the top of the document: the sidebar is transformed while it slides, and a
  // transformed ancestor makes fixed positioning relative to it rather than the viewport.
  return createPortal(
    <div className="search-backdrop" onClick={onClose}>
      <div
        className="search-modal"
        role="dialog"
        aria-label="Search sessions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-field">
          <SearchIcon size={20} className="search-field-icon" />
          <input
            ref={inputRef}
            className="search-modal-input"
            value={query}
            placeholder="Search sessions…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="search-esc">esc</kbd>
        </div>

        <div className="search-results">
          {results.length === 0 ? (
            <p className="search-empty">
              {query.trim() ? `No sessions match "${query}".` : 'No sessions yet.'}
            </p>
          ) : (
            results.map((s, i) => (
              <button
                key={s.chatId}
                className={`search-result ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(s.chatId)}
              >
                <span className="search-result-title">{s.title}</span>
                <span className="search-result-agent">{s.agentId ?? 'kiro_default'}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
