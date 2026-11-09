import { useEffect, useState } from 'react';
import type { DeviceInfo } from '@casper/shared';
import { api } from '../../api/rest.js';
import { relTime } from '../../util/relTime.js';
import { MonitorIcon, PhoneIcon } from '../common/icons.js';

interface Props {
  /** Called when the current device's own login is signed out (locks the app). */
  onSelfRevoked: () => void;
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

function isMobile(ua?: string): boolean {
  return !!ua && /iPhone|iPad|Android/.test(ua);
}

/** The logged-in devices, each with a way to sign it out, or all of them. */
export function DevicesPanel({ onSelfRevoked }: Props) {
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
    <section className="settings-card" aria-label="Logged-in devices">
      <header className="settings-card-head">
        <span className="settings-card-title">
          Logged-in devices {devices && <span className="settings-count">{devices.length}</span>}
        </span>
        {devices && devices.length > 1 && (
          <button className="btn-sm btn-ghost device-revoke" disabled={busy} onClick={() => void revokeAll()}>
            Sign out all
          </button>
        )}
      </header>
      {devices === null ? (
        <p className="settings-empty">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="settings-empty">No active devices.</p>
      ) : (
        devices.map((d) => (
          <div key={d.id} className="settings-item">
            <span className="settings-item-icon">
              {isMobile(d.userAgent) ? <PhoneIcon size={16} /> : <MonitorIcon size={16} />}
            </span>
            <span className="settings-item-text">
              <span className="settings-item-name">
                {deviceName(d.userAgent)}
                {d.current && <span className="device-badge">This device</span>}
              </span>
              <span className="settings-item-desc">Active {relTime(d.lastSeenAt, true)}</span>
            </span>
            <button className="btn-sm btn-ghost device-revoke" disabled={busy} onClick={() => void revoke(d)}>
              Sign out
            </button>
          </div>
        ))
      )}
    </section>
  );
}
