import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';
import { Dropdown } from '../common/Dropdown.js';
import { CheckIcon, ChevronIcon, ChevronRightIcon, WarningIcon } from '../common/icons.js';

const EFFORT_NAMES: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
};

/** The name an effort level is shown by. */
export function effortName(level: string): string {
  return EFFORT_NAMES[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

interface ModelPickerProps {
  value?: string;
  effort?: string;
  /** A draft shows the user's default effort for the model; a chat shows kiro's. */
  draft?: boolean;
  onChange: (modelId: string) => void;
  onEffortChange: (effortLevel: string) => void;
}

/**
 * Model selector, with the effort level in a side panel for a model that has levels. Each
 * row shows the credit multiplier so cost is visible at choice time.
 */
export function ModelPicker({ value, effort, draft, onChange, onEffortChange }: ModelPickerProps) {
  const models = useStore((s) => s.models);
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  // The keyboard row: an index into the models, or models.length for the effort row.
  const [active, setActive] = useState(0);
  const [effortActive, setEffortActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Nothing selected means the session will use the server's default, so name it
  // instead of showing an empty picker.
  const shownId = value ?? models.find((m) => m.isDefault)?.modelId;
  const model = models.find((m) => m.modelId === shownId);
  const levels = model?.effortLevels ?? [];
  const fallback = draft ? model?.defaultEffort : model?.recommendedEffort;
  const shownEffort = levels.length > 0 ? (effort && levels.includes(effort) ? effort : fallback) : undefined;
  const rows = models.length + (levels.length > 0 ? 1 : 0);

  const close = () => {
    setOpen(false);
    setEffortOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Start the keyboard row on the current model when the panel opens.
  useEffect(() => {
    if (!open) return;
    const i = models.findIndex((m) => m.modelId === shownId);
    setActive(i >= 0 ? i : 0);
    listRef.current?.querySelector('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openEffort = () => {
    const i = shownEffort ? levels.indexOf(shownEffort) : 0;
    setEffortActive(i >= 0 ? i : 0);
    setEffortOpen(true);
  };

  const pickModel = (modelId: string) => {
    if (modelId !== shownId) onChange(modelId);
    close();
  };

  const pickEffort = (level: string) => {
    if (level !== shownEffort) onEffortChange(level);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (effortOpen) {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setEffortOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setEffortActive((i) => Math.min(i + 1, levels.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setEffortActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const level = levels[effortActive];
        if (level) pickEffort(level);
      }
      return;
    }
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'ArrowRight' && active === models.length) {
      e.preventDefault();
      openEffort();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active === models.length) openEffort();
      else {
        const m = models[active];
        if (m) pickModel(m.modelId);
      }
    }
  };

  return (
    <div className="dd mp" ref={rootRef}>
      <button
        type="button"
        className={`dd-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onKeyDown}
        aria-label="Model"
      >
        <span className="dd-value">{model?.modelName ?? shownId ?? 'Select…'}</span>
        {shownEffort && <span className="mp-trigger-effort">{effortName(shownEffort)}</span>}
        <ChevronIcon size={13} className="dd-chevron" />
      </button>

      {open && (
        <div className="mp-panel">
          <div className="mp-list" role="listbox" aria-label="Models" ref={listRef}>
            {models.map((m, i) => (
              <button
                key={m.modelId}
                type="button"
                role="option"
                aria-selected={m.modelId === shownId}
                className={`mp-option ${i === active && !effortOpen ? 'is-active' : ''} ${
                  m.modelId === shownId ? 'is-selected' : ''
                }`}
                onMouseEnter={() => {
                  setActive(i);
                  setEffortOpen(false);
                }}
                onClick={() => pickModel(m.modelId)}
              >
                <span className="mp-option-name">{m.modelName}</span>
                <span className="dd-option-hint">{`${m.rateMultiplier}x`}</span>
                <span className="dd-check">{m.modelId === shownId && <CheckIcon size={15} />}</span>
              </button>
            ))}
          </div>

          {levels.length > 0 && shownEffort && (
            <>
              <div className="mp-divider" role="separator" />
              <button
                type="button"
                className={`mp-effort-row ${active === models.length || effortOpen ? 'is-active' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={effortOpen}
                onMouseEnter={() => {
                  setActive(models.length);
                  openEffort();
                }}
                onClick={() => (effortOpen ? setEffortOpen(false) : openEffort())}
              >
                <span className="mp-effort-label">Effort</span>
                <span className="mp-effort-value">{effortName(shownEffort)}</span>
                <ChevronRightIcon size={13} className="mp-effort-chevron" />
              </button>
            </>
          )}

          {effortOpen && levels.length > 0 && (
            <div className="mp-effort" role="listbox" aria-label="Effort">
              {levels.map((level, i) => (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={level === shownEffort}
                  className={`mp-option mp-level ${i === effortActive ? 'is-active' : ''} ${
                    level === shownEffort ? 'is-selected' : ''
                  }`}
                  onMouseEnter={() => setEffortActive(i)}
                  onClick={() => pickEffort(level)}
                >
                  <span className="mp-option-name">{effortName(level)}</span>
                  {level === model?.recommendedEffort && <span className="mp-pill">Recommended</span>}
                  {level === 'max' && (
                    <span className="mp-pill is-warn">
                      <WarningIcon size={11} />
                      Uses the most credits
                    </span>
                  )}
                  <span className="dd-check">{level === shownEffort && <CheckIcon size={15} />}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface AgentPickerProps {
  value?: string;
  onChange: (modeId: string) => void;
}

/**
 * Agent selector. Prefers the live session's available modes, but falls back to
 * the global agent list (from /api/agents) so it's always populated - even
 * before a session has spawned a process.
 */
export function AgentPicker({ value, onChange }: AgentPickerProps) {
  const sessionModes = useStore((s) => s.modes);
  const globalAgents = useStore((s) => s.agents);
  const defaultAgentId = useStore((s) => s.defaultAgentId);
  const list = sessionModes.length > 0 ? sessionModes : globalAgents;
  const shown = value ?? defaultAgentId;
  return (
    <Dropdown
      ariaLabel="Agent"
      value={shown}
      onChange={onChange}
      options={list.map((m) => ({ value: m.id, label: m.name }))}
    />
  );
}
