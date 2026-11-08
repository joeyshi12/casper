import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Memory } from '@casper/shared';
import { api } from '../../api/rest.js';

/** Where a memory applies, and whether it is a preference or a fact, in words. */
function memoryKind(m: Memory): string {
  const kind = m.memoryType === 'USER_PREFERENCE' ? 'Preference' : m.memoryType === 'SEMANTIC' ? 'Fact' : m.memoryType;
  const scope = m.scopes?.[0];
  const where = !scope || scope === 'Global' ? 'everywhere' : scope.replace(/^(workspace|repo):/, '');
  return `${kind} · ${where}`;
}

interface Props {
  onClose: () => void;
}

/** kiro's saved memories, with a way to delete one. */
export function MemoriesModal({ onClose }: Props) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api.memories().then(
      (r) => {
        setMemories(r.memories);
        setError(null);
      },
      (err: unknown) => {
        setMemories([]);
        setError(err instanceof Error ? err.message : 'Could not read memories.');
      },
    );

  useEffect(() => {
    void refresh();
  }, []);

  const remove = async (m: Memory) => {
    setBusy(true);
    try {
      await api.deleteMemory(m.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the memory.');
    } finally {
      setBusy(false);
    }
  };

  // Portalled for the same reason as the devices list: the sidebar is transformed.
  return createPortal(
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-modal" role="dialog" aria-label="Memories" onClick={(e) => e.stopPropagation()}>
        <div className="devices-head">
          <span className="devices-title">Memories</span>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="devices-list">
          {error && <p className="search-empty memory-error">{error}</p>}
          {memories === null ? (
            <p className="search-empty">Loading…</p>
          ) : memories.length === 0 ? (
            !error && (
              <p className="search-empty">
                kiro has no saved memories. It saves them only when memory is on, through kiro&rsquo;s{' '}
                <code>memory.mode</code> setting.
              </p>
            )
          ) : (
            memories.map((m) => (
              <div key={m.id} className="device-row">
                <span className="device-main">
                  <span className="device-name">
                    {m.title}
                    <span className="device-badge">{memoryKind(m)}</span>
                  </span>
                  <span className="device-sub">{m.summary}</span>
                </span>
                <button className="btn-ghost device-revoke" disabled={busy} onClick={() => void remove(m)}>
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
