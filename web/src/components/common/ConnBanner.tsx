import type { ConnStatus } from '../../api/SessionSocket.js';

/** A coloured dot plus a short label: amber catching up, red disconnected. Nothing while
 *  connected, which is the normal state and needs no label. */
const MAP: Record<Exclude<ConnStatus, 'connected'>, { cls: string; label: string }> = {
  connecting: { cls: 'busy', label: 'Connecting' },
  replaying: { cls: 'busy', label: 'Catching up' },
  reconnecting: { cls: 'busy', label: 'Reconnecting' },
  resyncing: { cls: 'busy', label: 'Resyncing' },
  closed: { cls: 'down', label: 'Offline' },
};

export function ConnDot({ status }: { status: ConnStatus }) {
  if (status === 'connected') return null;
  const { cls, label } = MAP[status];
  return (
    <span className={`conndot conndot-${cls}`}>
      <span className="conndot-blip" />
      <span className="conndot-label">{label}</span>
    </span>
  );
}
