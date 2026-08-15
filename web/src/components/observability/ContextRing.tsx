import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store.js';

/** Ring geometry. Small enough to sit inline with the composer controls. */
const SIZE = 18;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

function colorFor(pct: number): string {
  if (pct > 85) return 'var(--aurora-red)';
  if (pct > 60) return 'var(--aurora-orange)';
  return 'var(--frost)';
}

const fmt = new Intl.NumberFormat();

/**
 * Context-window usage as a ring, with the numbers behind a click.
 *
 * kiro only reports a percentage, so the token figures are derived from the
 * selected model's window and labelled as approximate rather than presented as
 * exact counts.
 */
export function ContextRing({ onCompact }: { onCompact: () => void }) {
  const pct = useStore((s) => s.observability.contextUsagePercentage);
  const compacting = useStore((s) => s.observability.compacting);
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const activeId = useStore((s) => s.activeId);
  const currentModelId = useStore((s) => s.currentModelId);
  const models = useStore((s) => s.models);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const clamped = Math.max(0, Math.min(100, pct));
  const color = colorFor(clamped);
  const dash = (clamped / 100) * CIRCUMFERENCE;

  // Not `window`: that shadows the DOM global in a component that may later
  // need it.
  const windowTokens = models.find((m) => m.modelId === currentModelId)?.contextWindowTokens;
  const used = windowTokens ? Math.round((clamped / 100) * windowTokens) : undefined;

  // Nothing to report before a session exists: an empty ring reads as a spinner.
  if (!activeId) return null;

  return (
    <div className="ctx" ref={rootRef}>
      <button
        type="button"
        className="ctx-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context ${clamped.toFixed(0)}% used`}
        title={`Context ${clamped.toFixed(0)}% used`}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          {/* Rotated so the arc starts at 12 o'clock rather than 3. */}
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke="var(--n2)"
              strokeWidth={STROKE}
            />
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={color}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
            />
          </g>
        </svg>
      </button>

      {open && (
        <div className="ctx-pop" role="dialog" aria-label="Context usage">
          <div className="ctx-pop-head">
            <span className="ctx-pop-title">Context used</span>
            <span className="ctx-pop-pct" style={{ color }}>
              {clamped.toFixed(1)}%
            </span>
          </div>

          <div className="ctx-pop-bar">
            <span
              className="ctx-pop-bar-fill"
              style={{ width: `${clamped}%`, background: color }}
            />
          </div>

          {windowTokens ? (
            <dl className="ctx-pop-rows">
              <div className="ctx-pop-row">
                <dt>Used</dt>
                <dd>{fmt.format(used ?? 0)} tokens</dd>
              </div>
              <div className="ctx-pop-row">
                <dt>Window</dt>
                <dd>{fmt.format(windowTokens)} tokens</dd>
              </div>
            </dl>
          ) : (
            <p className="ctx-pop-note">
              Token counts need a selected model&rsquo;s window size.
            </p>
          )}

          <button
            type="button"
            className="ctx-pop-compact"
            disabled={!activeId || compacting || turnStatus !== 'idle'}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            {compacting ? 'Compacting…' : 'Compact conversation'}
          </button>
        </div>
      )}
    </div>
  );
}
