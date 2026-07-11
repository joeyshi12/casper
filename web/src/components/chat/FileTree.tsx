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

interface PreviewState {
  path: string;
  name: string;
  content: string | null;
  isImage: boolean;
  loading: boolean;
  error: string | null;
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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

function TreeEntry({
  entry,
  sessionId,
  depth,
  onPreview,
}: {
  entry: FileEntry;
  sessionId: string;
  depth: number;
  onPreview: (entry: FileEntry) => void;
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
      window.open(url, '_blank');
    },
    [sessionId, entry.path],
  );

  const handleClick = useCallback(() => {
    if (entry.type === 'file') {
      onPreview(entry);
    }
  }, [entry, onPreview]);

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
                onPreview={onPreview}
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
      onClick={handleClick}
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

/** File preview panel - shows text content or image inline. */
function FilePreview({
  preview,
  sessionId,
  onClose,
}: {
  preview: PreviewState;
  sessionId: string;
  onClose: () => void;
}) {
  const download = () => {
    window.open(api.downloadUrl(sessionId, preview.path), '_blank');
  };

  return (
    <div className="ftree-preview">
      <div className="ftree-preview-header">
        <button className="ftree-preview-back" onClick={onClose} aria-label="Back to file tree">
          ‹
        </button>
        <span className="ftree-preview-name" title={preview.path}>
          {preview.name}
        </span>
        <button
          className="ftree-preview-dl"
          onClick={download}
          title="Download file"
          aria-label="Download file"
        >
          ⬇
        </button>
      </div>
      <div className="ftree-preview-body">
        {preview.loading && <div className="ftree-loading">Loading…</div>}
        {preview.error && <div className="ftree-error">{preview.error}</div>}
        {!preview.loading && !preview.error && preview.isImage && (
          <img
            src={api.previewUrl(sessionId, preview.path)}
            alt={preview.name}
            className="ftree-preview-image"
          />
        )}
        {!preview.loading && !preview.error && !preview.isImage && preview.content !== null && (
          <pre className="ftree-preview-code">{preview.content}</pre>
        )}
      </div>
    </div>
  );
}

/** Workspace file tree panel with lazy folder expansion, preview, and download. */
export function FileTree({ sessionId }: FileTreeProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [cwd, setCwd] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

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

  const openPreview = useCallback(
    async (entry: FileEntry) => {
      const image = isImageFile(entry.name);
      setPreview({
        path: entry.path,
        name: entry.name,
        content: null,
        isImage: image,
        loading: !image, // Images load via <img> src, no fetch needed
        error: null,
      });

      // For text files, fetch the content.
      if (!image) {
        try {
          const url = api.previewUrl(sessionId, entry.path);
          const res = await fetch(url, { credentials: 'same-origin' });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(body || `HTTP ${res.status}`);
          }
          const text = await res.text();
          setPreview((p) =>
            p && p.path === entry.path ? { ...p, content: text, loading: false } : p,
          );
        } catch (err) {
          setPreview((p) =>
            p && p.path === entry.path
              ? { ...p, error: (err as Error).message, loading: false }
              : p,
          );
        }
      }
    },
    [sessionId],
  );

  const closePreview = useCallback(() => setPreview(null), []);

  // When preview is active, show the preview panel instead of the tree.
  if (preview) {
    return (
      <div className="ftree-panel">
        <FilePreview preview={preview} sessionId={sessionId} onClose={closePreview} />
      </div>
    );
  }

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
              onPreview={openPreview}
            />
          ))}
      </div>
    </div>
  );
}
