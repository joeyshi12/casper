import { useStore } from '../../state/store.js';

/** Slim horizontal meter for context-window usage - aligns on the baseline. */
function ContextMeter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color =
    clamped > 85 ? 'var(--aurora-red)' : clamped > 60 ? 'var(--lantern)' : 'var(--frost)';
  return (
    <span className="meter">
      <span className="meter-track">
        <span
          className="meter-fill"
          style={{ width: `${clamped}%`, background: color }}
        />
      </span>
      <span className="obs-value">{clamped.toFixed(0)}%</span>
    </span>
  );
}

/**
 * Live session stats - credits, context usage, and last-turn duration - shown
 * as a compact strip beneath the prompt. Details view is intentionally omitted.
 */
export function ObservabilityPanel() {
  const obs = useStore((s) => s.observability);

  return (
    <div className="obs">
      <div className="obs-strip">
        <div className="obs-stat">
          <span className="obs-key">credits</span>
          <span className="obs-value obs-credits">{obs.creditsSpent.toFixed(3)}</span>
        </div>
        <div className="obs-stat">
          <span className="obs-key">context</span>
          <ContextMeter pct={obs.contextUsagePercentage} />
        </div>
        <div className="obs-stat">
          <span className="obs-key">last turn</span>
          <span className="obs-value">
            {obs.lastTurnDurationMs ? `${(obs.lastTurnDurationMs / 1000).toFixed(1)}s` : '-'}
          </span>
        </div>
      </div>
    </div>
  );
}
