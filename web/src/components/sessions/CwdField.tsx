import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/rest.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  hint?: string;
  autoFocus?: boolean;
}

/**
 * Working-directory input with debounced directory autocomplete. Shared by the
 * new-session sheet and the change-folder sheet so both resolve paths the same
 * way (server-side suggestions, confined to CASPER_FILE_ROOT).
 */
export function CwdField({
  value,
  onChange,
  label = 'Working directory',
  placeholder = 'leave blank for server default',
  hint = "A folder that doesn't exist yet will be created.",
  autoFocus = false,
}: Props) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  // Track the query we last requested so out-of-order responses are ignored.
  const queryRef = useRef('');

  useEffect(() => {
    if (!showSuggestions) return;
    const q = value;
    queryRef.current = q;
    const t = setTimeout(() => {
      api
        .listDirs(q)
        .then((r) => {
          if (queryRef.current === q) setSuggestions(r.entries);
        })
        .catch(() => setSuggestions([]));
    }, 150);
    return () => clearTimeout(t);
  }, [value, showSuggestions]);

  return (
    <label className="picker cwd-field">
      <span className="picker-label">{label}</span>
      <input
        className="picker-input"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onFocus={() => setShowSuggestions(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setShowSuggestions(true);
        }}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
      />
      {showSuggestions && suggestions.length > 0 && (
        <div className="cwd-suggestions">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="cwd-suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(s);
                setSuggestions([]);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <span className="picker-hint">{hint}</span>
    </label>
  );
}
