import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@casper/shared';
import { fuzzyScore } from '../../util/fuzzy.js';
import { SearchIcon } from '../common/icons.js';

interface Props {
  sessions: SessionSummary[];
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

  // Keep the active index in range as results change.
  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (id: string) => {
    onOpen(id);
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
      if (hit) choose(hit.sessionId);
    }
  };

  return (
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
                key={s.sessionId}
                className={`search-result ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(s.sessionId)}
              >
                <span className="search-result-title">{s.title}</span>
                <span className="search-result-agent">{s.agentId ?? 'kiro_default'}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
