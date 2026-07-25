import { useState } from 'react';
import { api } from '../../api/rest.js';
import { CwdField } from './CwdField.js';

interface Props {
  sessionId: string;
  /** Current working directory, shown for reference. */
  currentCwd?: string;
  /** Called with the resolved path after a successful change. */
  onChanged: (cwd: string) => void;
  onClose: () => void;
}

/**
 * Re-point an existing session at a different working directory. Needed when the
 * folder a session was created in has been moved or deleted, which otherwise
 * leaves its file tree and prompts broken.
 */
export function ChangeFolderSheet({ sessionId, currentCwd, onChanged, onClose }: Props) {
  const [cwd, setCwd] = useState(currentCwd ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const target = cwd.trim();
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.setSessionCwd(sessionId, target);
      onChanged(res.cwd);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">Change working directory</h2>

        <CwdField
          value={cwd}
          onChange={setCwd}
          placeholder="/path/to/folder"
          hint="The session keeps its transcript. A folder that doesn't exist yet will be created."
          autoFocus
        />

        {error && <div className="sheet-error">{error}</div>}

        <div className="sheet-actions">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !cwd.trim()}>
            {saving ? 'Saving…' : 'Change folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
