import type { ConnStatus } from '../../api/SessionSocket.js';

/**
 * A small connection indicator: a coloured dot plus a short label. Green when
 * connected, amber while catching up, red when disconnected - quiet, but
 * readable at a glance. Replaces the old full-width "Connecting…" ribbon.
 */
const MAP: Record<ConnStatus, { cls: string; label: string }> = {
  connecting: { cls: 'busy', label: 'Connecting' },
  replaying: { cls: 'busy', label: 'Catching up' },
  connected: { cls: 'ok', label: 'Live' },
  reconnecting: { cls: 'busy', label: 'Reconnecting' },
  resyncing: { cls: 'busy', label: 'Resyncing' },
  closed: { cls: 'down', label: 'Offline' },
};

export function ConnDot({ status }: { status: ConnStatus }) {
  const { cls, label } = MAP[status];
  return (
    <span className={`conndot conndot-${cls}`}>
      <span className="conndot-blip" />
      <span className="conndot-label">{label}</span>
    </span>
  );
}
