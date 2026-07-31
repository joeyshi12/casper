import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/rest.js';
import type { DirListing } from '@casper/shared';

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
  // The resolved absolute path and what it currently is, so the field can say a
  // folder will be created (or that the path is a file). Kept separate from
  // `suggestions` because it must survive losing focus - the notice matters most
  // once typing stops.
  const [target, setTarget] = useState<{ path: string; kind: DirListing['targetKind'] } | null>(
    null,
  );
  // Track the query we last requested so out-of-order responses are ignored.
  const queryRef = useRef('');

  useEffect(() => {
    const q = value;
    queryRef.current = q;
    const t = setTimeout(() => {
      api
        .listDirs(q)
        .then((r) => {
          if (queryRef.current !== q) return;
          setSuggestions(r.entries);
          setTarget({ path: r.target, kind: r.targetKind });
        })
        .catch(() => {
          if (queryRef.current !== q) return;
          setSuggestions([]);
          // Don't claim anything about a path we couldn't resolve (e.g. outside
          // the allowed root, which create would reject anyway).
          setTarget(null);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [value]);

  const typed = value.trim() !== '';
  const willCreate = typed && target?.kind === 'missing';
  const isFile = typed && target?.kind === 'file';

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
      {willCreate && (
        <span className="picker-hint cwd-will-create">
          Doesn&apos;t exist yet - this folder will be created: <code>{target.path}</code>
        </span>
      )}
      {isFile && (
        <span className="picker-hint cwd-is-file">
          That path is a file, not a folder: <code>{target.path}</code>
        </span>
      )}
      {!willCreate && !isFile && <span className="picker-hint">{hint}</span>}
    </label>
  );
}
