import { useEffect, useRef, useState } from 'react';
import { CheckIcon, ChevronIcon } from './icons.js';

export interface DropdownOption {
  value: string;
  label: string;
  /** Optional secondary text shown dim on the right (e.g. a credit rate). */
  hint?: string;
}

interface Props {
  label: string;
  value?: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}

/**
 * A custom dropdown that replaces the native <select> - themed to match the
 * app, with a chevron trigger, a floating panel, checkmark on the current
 * option, and keyboard support (↑/↓/Enter/Esc).
 */
export function Dropdown({ label, value, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // When opening, focus the current selection.
  useEffect(() => {
    if (open) {
      const i = options.findIndex((o) => o.value === value);
      setActive(i >= 0 ? i : 0);
    }
  }, [open, options, value]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[active];
      if (opt) commit(opt.value);
    }
  };

  return (
    <div className="dd" ref={rootRef}>
      <button
        type="button"
        className={`dd-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="dd-label">{label}</span>
        <span className="dd-value">{selected?.label ?? value ?? 'Select…'}</span>
        <ChevronIcon size={13} className="dd-chevron" />
      </button>

      {open && (
        <div className="dd-panel" role="listbox">
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd-option ${i === active ? 'is-active' : ''} ${
                o.value === value ? 'is-selected' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(o.value)}
            >
              <span className="dd-check">
                {o.value === value && <CheckIcon size={15} />}
              </span>
              <span className="dd-option-label">{o.label}</span>
              {o.hint && <span className="dd-option-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
