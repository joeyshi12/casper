import type { ConnStatus } from '../api/SessionSocket.js';

const OFFLINE: Partial<Record<ConnStatus, string>> = {
  closed: 'Offline - reconnecting when possible',
  reconnecting: 'Reconnecting…',
  resyncing: 'Resyncing…',
};

/**
 * What the composer says when it is empty. A draft has no socket - sending is what creates
 * the session - so the connection states only apply once there is a connection to describe.
 */
export function composerPlaceholder(s: {
  live: boolean;
  connStatus: ConnStatus;
  uploading: boolean;
  cancelling: boolean;
  compacting: boolean;
  running: boolean;
}): string {
  if (!s.live) return OFFLINE[s.connStatus] ?? 'Connecting…';
  if (s.uploading) return 'Uploading…';
  if (s.cancelling) return 'Stopping…';
  if (s.compacting) return 'Compacting conversation…';
  if (s.running) return 'Casper is working…';
  return 'Ask Casper to build something…';
}
