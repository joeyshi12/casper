import type { ConnStatus } from '../../api/SessionSocket.js';

/** A coloured dot plus a short label: green connected, amber catching up, red disconnected. */
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
