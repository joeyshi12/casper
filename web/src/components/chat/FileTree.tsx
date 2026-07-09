import { useCallback, useEffect, useState } from 'react';
import type { FileEntry } from '@casper/shared';
import { api } from '../../api/rest.js';

interface FileTreeProps {
  sessionId: string;
}

interface FolderState {
  expanded: boolean;
  children: FileEntry[] | null;
  loading: boolean;
}

/** Format bytes into human-readable size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Get a simple icon character for a file based on extension. */
function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
      return '📄';
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return '⚙️';
    case 'md':
    case 'txt':
    case 'rst':
      return '📝';
    case 'css':
    case 'scss':
    case 'less':
      return '🎨';
    case 'html':
    case 'svg':
      return '🌐';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return '🖼️';
    case 'sh':
    case 'bash':
    case 'zsh':
      return '⚡';
    default:
      return '📄';
  }
}

function TreeEntry({
  entry,
  sessionId,
  depth,
}: {
  entry: FileEntry;
  sessionId: string;
  depth: number;
}) {
  const [folder, setFolder] = useState<FolderState>({
    expanded: false,
    children: null,
    loading: false,
  });

  const toggle = useCallback(async () => {
    if (entry.type !== 'directory') return;

    if (folder.expanded) {
      setFolder((f) => ({ ...f, expanded: false }));
      return;
    }

    // If we haven't loaded children yet, fetch them.
    if (folder.children === null) {
      setFolder((f) => ({ ...f, loading: true }));
      try {
        const res = await api.tree(sessionId, entry.path);
        setFolder({ expanded: true, children: res.entries, loading: false });
      } catch {
        setFolder((f) => ({ ...f, loading: false }));
      }
    } else {
      setFolder((f) => ({ ...f, expanded: true }));
    }
  }, [entry, sessionId, folder.expanded, folder.children]);

  const download = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const url = api.downloadUrl(sessionId, entry.path);
      // Open in a new tab to trigger the browser download.
      window.open(url, '_blank');
    },
    [sessionId, entry.path],
  );

  const indent = depth * 16;

  if (entry.type === 'directory') {
    return (
      <>
        <button
          className="ftree-row ftree-dir"
          onClick={toggle}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          <span className="ftree-chevron">
            {folder.loading ? '⏳' : folder.expanded ? '▾' : '▸'}
          </span>
          <span className="ftree-icon">📁</span>
          <span className="ftree-name">{entry.name}</span>
        </button>
        {folder.expanded && folder.children && (
          <div className="ftree-children">
            {folder.children.map((child) => (
              <TreeEntry
                key={child.path}
                entry={child}
                sessionId={sessionId}
                depth={depth + 1}
              />
            ))}
            {folder.children.length === 0 && (
              <div
                className="ftree-empty"
                style={{ paddingLeft: `${indent + 24}px` }}
              >
                Empty
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className="ftree-row ftree-file"
      style={{ paddingLeft: `${indent + 8}px` }}
    >
      <span className="ftree-icon">{fileIcon(entry.name)}</span>
      <span className="ftree-name">{entry.name}</span>
      {entry.size != null && (
        <span className="ftree-size">{formatSize(entry.size)}</span>
      )}
      <button
        className="ftree-download"
        onClick={download}
        title={`Download ${entry.name}`}
        aria-label={`Download ${entry.name}`}
      >
        ⬇
      </button>
    </div>
  );
}

/** Workspace file tree panel with lazy folder expansion and download buttons. */
export function FileTree({ sessionId }: FileTreeProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [cwd, setCwd] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.tree(sessionId);
      setEntries(res.entries);
      setCwd(res.cwd);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="ftree-panel">
      <div className="ftree-header">
        <span className="ftree-title" title={cwd}>
          {cwd ? cwd.split('/').pop() : 'Files'}
        </span>
        <button
          className="ftree-refresh"
          onClick={refresh}
          title="Refresh file tree"
          aria-label="Refresh file tree"
        >
          ↻
        </button>
      </div>
      {cwd && <div className="ftree-cwd" title={cwd}>{cwd}</div>}
      <div className="ftree-list">
        {loading && <div className="ftree-loading">Loading…</div>}
        {error && <div className="ftree-error">{error}</div>}
        {!loading && !error && entries.length === 0 && (
          <div className="ftree-empty">No files</div>
        )}
        {!loading &&
          !error &&
          entries.map((entry) => (
            <TreeEntry
              key={entry.path}
              entry={entry}
              sessionId={sessionId}
              depth={0}
            />
          ))}
      </div>
    </div>
  );
}
