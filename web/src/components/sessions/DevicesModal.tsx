import { useEffect, useState } from 'react';
import type { DeviceInfo } from '@casper/shared';
import { api } from '../../api/rest.js';

interface Props {
  onClose: () => void;
  /** Called when the current device's own session is revoked (locks the app). */
  onSelfRevoked: () => void;
}

function relTime(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Turn a User-Agent into something short and readable.
function deviceName(ua?: string): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Macintosh|Mac OS/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Device';
  const browser = /Firefox/.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${os} · ${browser}` : os;
}

/** Lists logged-in devices and lets you revoke any one, or all of them. */
export function DevicesModal({ onClose, onSelfRevoked }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.devices().then((r) => setDevices(r.devices)).catch(() => setDevices([]));

  useEffect(() => {
    void refresh();
  }, []);

  const revoke = async (d: DeviceInfo) => {
    setBusy(true);
    try {
      await api.revokeDevice(d.id);
      if (d.current) {
        onSelfRevoked();
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    setBusy(true);
    try {
      await api.logoutAll();
      onSelfRevoked();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div
        className="search-modal"
        role="dialog"
        aria-label="Logged-in devices"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="devices-head">
          <span className="devices-title">Logged-in devices</span>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="devices-list">
          {devices === null ? (
            <p className="search-empty">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="search-empty">No active devices.</p>
          ) : (
            devices.map((d) => (
              <div key={d.id} className="device-row">
                <span className="device-main">
                  <span className="device-name">
                    {deviceName(d.userAgent)}
                    {d.current && <span className="device-badge">This device</span>}
                  </span>
                  <span className="device-sub">Active {relTime(d.lastSeenAt)}</span>
                </span>
                <button
                  className="btn-ghost device-revoke"
                  disabled={busy}
                  onClick={() => revoke(d)}
                >
                  {d.current ? 'Log out' : 'Revoke'}
                </button>
              </div>
            ))
          )}
        </div>

        {devices && devices.length > 1 && (
          <div className="devices-foot">
            <button className="btn-ghost device-revoke" disabled={busy} onClick={revokeAll}>
              Log out all devices
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
