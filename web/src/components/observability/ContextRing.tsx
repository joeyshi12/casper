import { useEffect, useRef, useState } from 'react';
import type { ChatUsageResponse, ContextBreakdown } from '@casper/shared';
import { api } from '../../api/rest.js';
import { formatCredits } from '../../util/credits.js';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';

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

function resetDay(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00`);
  return Number.isNaN(d.getTime()) ? isoDay : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const PARTS: { key: keyof ContextBreakdown; label: string; color: string }[] = [
  { key: 'prompts', label: 'Your messages', color: 'var(--frost)' },
  { key: 'responses', label: 'Responses', color: 'var(--frost-teal)' },
  { key: 'tools', label: 'Tools', color: 'var(--aurora-purple)' },
  { key: 'contextFiles', label: 'Context files', color: 'var(--aurora-yellow)' },
  { key: 'sessionFiles', label: 'Session files', color: 'var(--aurora-green)' },
  { key: 'memory', label: 'Memory', color: 'var(--aurora-orange)' },
];

/** The parts of the used context worth listing, plus what kiro does not itemise (its
 *  system prompt among it) as the rest of the used total. */
export function breakdownParts(
  used: number,
  breakdown: ContextBreakdown | undefined,
): { label: string; color: string; pct: number }[] {
  if (!breakdown) return [];
  const parts = PARTS.filter((p) => breakdown[p.key] >= 0.05).map((p) => ({
    label: p.label,
    color: p.color,
    pct: breakdown[p.key],
  }));
  if (parts.length === 0) return [];
  const rest = used - parts.reduce((sum, p) => sum + p.pct, 0);
  if (rest >= 0.05) parts.push({ label: 'System and other', color: 'var(--n3)', pct: rest });
  return parts;
}

/**
 * Context-window usage as a ring, with the numbers behind a click.
 *
 * kiro reports a percentage of the window, and for a live session what each part of the
 * context takes. The token figures are derived from the selected model's window.
 */
export function ContextRing() {
  const pct = useStore((s) => s.observability.contextUsagePercentage);
  const breakdown = useStore((s) => s.observability.contextBreakdown);
  const liveCredits = useStore((s) => s.observability.sessionCredits);
  const [usage, setUsage] = useState<ChatUsageResponse | null>(null);
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

  // The breakdown and the credits are read from kiro each time the popover opens. The
  // breakdown comes back as a metadata event, so the ring's own state stays in the store.
  useEffect(() => {
    if (!open || !activeId) return;
    let live = true;
    api.chatUsage(activeId).then(
      (u) => live && setUsage(u),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, activeId]);

  useEffect(() => setUsage(null), [activeId]);

  const clamped = Math.max(0, Math.min(100, pct));
  const color = colorFor(clamped);
  const dash = (clamped / 100) * CIRCUMFERENCE;

  // Not `window`: that shadows the DOM global in a component that may later
  // need it.
  const windowTokens = models.find((m) => m.modelId === currentModelId)?.contextWindowTokens;
  const used = windowTokens ? Math.round((clamped / 100) * windowTokens) : undefined;
  const parts = breakdownParts(clamped, breakdown);

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
            {parts.length > 0 ? (
              parts.map((p) => (
                <span
                  key={p.label}
                  className="ctx-pop-bar-part"
                  style={{ width: `${Math.min(100, p.pct)}%`, background: p.color }}
                />
              ))
            ) : (
              <span
                className="ctx-pop-bar-fill"
                style={{ width: `${clamped}%`, background: color }}
              />
            )}
          </div>

          {parts.length > 0 && (
            <dl className="ctx-pop-rows ctx-pop-parts">
              {parts.map((p) => (
                <div className="ctx-pop-row" key={p.label}>
                  <dt>
                    <span className="ctx-pop-dot" style={{ background: p.color }} />
                    {p.label}
                  </dt>
                  <dd>{p.pct.toFixed(1)}%</dd>
                </div>
              ))}
            </dl>
          )}

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

          {(usage?.credits !== undefined || liveCredits !== undefined || usage?.account) && (
            <dl className="ctx-pop-rows ctx-pop-credits">
              {(usage?.credits !== undefined || liveCredits !== undefined) && (
                <div className="ctx-pop-row">
                  <dt>This chat</dt>
                  <dd>{formatCredits(Math.max(usage?.credits ?? 0, liveCredits ?? 0))} credits</dd>
                </div>
              )}
              {usage?.account && (
                <div className="ctx-pop-row">
                  <dt title={usage.account.planName}>This month</dt>
                  <dd>
                    {fmt.format(Math.round(usage.account.used))}
                    {usage.account.limit !== undefined && ` / ${fmt.format(usage.account.limit)}`}
                  </dd>
                </div>
              )}
              {usage?.account?.resetsOn && (
                <div className="ctx-pop-row">
                  <dt>Resets</dt>
                  <dd>{resetDay(usage.account.resetsOn)}</dd>
                </div>
              )}
            </dl>
          )}

          <button
            type="button"
            className="ctx-pop-compact"
            disabled={compacting || turnStatus !== 'idle'}
            onClick={() => {
              setOpen(false);
              sessionController.compact();
            }}
          >
            {compacting ? 'Compacting…' : 'Compact conversation'}
          </button>
        </div>
      )}
    </div>
  );
}
