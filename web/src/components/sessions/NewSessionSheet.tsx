import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { api } from '../../api/rest.js';
import { ModelPicker, AgentPicker } from '../controls/Pickers.js';

interface Props {
  onCreate: (opts: { cwd: string; agentId: string; modelId: string }) => void;
  onClose: () => void;
}

export function NewSessionSheet({ onCreate, onClose }: Props) {
  const models = useStore((s) => s.models);
  const defaultAgentId = useStore((s) => s.defaultAgentId);
  const [cwd, setCwd] = useState('');
  const [agentOverride, setAgentOverride] = useState<string>();
  const [modelOverride, setModelOverride] = useState<string>();
  const agentId = agentOverride ?? defaultAgentId;
  const modelId =
    modelOverride ?? models.find((m) => m.isDefault)?.modelId ?? 'auto';

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  // Track the query we last requested so out-of-order responses are ignored.
  const queryRef = useRef('');

  // Debounced directory lookup as the user types.
  useEffect(() => {
    if (!showSuggestions) return;
    const q = cwd;
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
  }, [cwd, showSuggestions]);

  const pick = (full: string) => {
    setCwd(full);
    setSuggestions([]);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">New session</h2>

        <label className="picker cwd-field">
          <span className="picker-label">Working directory</span>
          <input
            className="picker-input"
            value={cwd}
            placeholder="leave blank for server default"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => setShowSuggestions(true)}
            onChange={(e) => {
              setCwd(e.target.value);
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
                  onClick={() => pick(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <span className="picker-hint">
            A folder that doesn't exist yet will be created.
          </span>
        </label>

        <AgentPicker value={agentId} onChange={setAgentOverride} />
        <ModelPicker value={modelId} onChange={setModelOverride} />

        <div className="sheet-actions">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onCreate({ cwd: cwd.trim(), agentId, modelId })}
          >
            Start session
          </button>
        </div>
      </div>
    </div>
  );
}
