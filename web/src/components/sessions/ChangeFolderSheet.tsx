import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/rest.js';
import { DirectoryPicker } from './DirectoryPicker.js';

interface Props {
  chatId: string;
  /** Current working directory, where browsing starts. */
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
export function ChangeFolderSheet({ chatId, currentCwd, onChanged, onClose }: Props) {
  const [cwd, setCwd] = useState(currentCwd ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A click fires on the common ancestor of press and release, so dragging a selection out
   * of the input raises one on the backdrop. Require the press to have started there too.
   */
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The picker swallows Escape while its suggestion list is open.
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    const target = cwd.trim();
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.setChatCwd(chatId, target);
      onChanged(res.cwd);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-folder-title"
      >
        <h2 className="sheet-title" id="change-folder-title">
          Change working directory
        </h2>

        <DirectoryPicker
          initialPath={currentCwd ?? ''}
          onChange={setCwd}
          onSubmit={submit}
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
