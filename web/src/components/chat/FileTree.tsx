import { useCallback, useEffect, useState } from 'react';
import type { FileEntry } from '@casper/shared';
import { api } from '../../api/rest.js';
import { highlightToHtml } from '../../util/highlighter.js';
import {
  FileIcon,
  FileCodeIcon,
  FileConfigIcon,
  FileTextIcon,
  FileImageIcon,
  FileStyleIcon,
  FileTerminalIcon,
  FolderIcon,
  FolderOpenIcon,
  DownloadIcon,
  RefreshIcon,
  CloseIcon,
  ChevronIcon,
  Spinner,
} from '../common/icons.js';

interface FileTreeProps {
  sessionId: string;
  /** Collapse the panel. Used by the mobile close button, where the header
   *  toggle is covered by the panel overlay. */
  onClose?: () => void;
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
  highlightedHtml: string | null;
  isImage: boolean;
  isPdf: boolean;
  loading: boolean;
  error: string | null;
}

/** Format bytes into human-readable size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Get the appropriate icon component for a file based on extension. */
function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'py':
    case 'rb':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'vue':
    case 'svelte':
      return <FileCodeIcon size={15} className="ftree-icon-svg ftree-icon-code" />;
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'env':
    case 'lock':
      return <FileConfigIcon size={15} className="ftree-icon-svg ftree-icon-config" />;
    case 'md':
    case 'txt':
    case 'rst':
    case 'log':
    case 'csv':
      return <FileTextIcon size={15} className="ftree-icon-svg ftree-icon-text" />;
    case 'css':
    case 'scss':
    case 'less':
    case 'sass':
      return <FileStyleIcon size={15} className="ftree-icon-svg ftree-icon-style" />;
    case 'html':
    case 'svg':
    case 'xml':
      return <FileCodeIcon size={15} className="ftree-icon-svg ftree-icon-markup" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'ico':
    case 'avif':
      return <FileImageIcon size={15} className="ftree-icon-svg ftree-icon-image" />;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'bat':
    case 'ps1':
      return <FileTerminalIcon size={15} className="ftree-icon-svg ftree-icon-terminal" />;
    default:
      return <FileIcon size={15} className="ftree-icon-svg" />;
  }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

function isPdfFile(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

/** Map file extension to shiki language id. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'css',
  less: 'css',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  zig: 'zig',
  lua: 'lua',
  tex: 'latex',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  dockerfile: 'dockerfile',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
};

function langFromFilename(name: string): string {
  const lower = name.toLowerCase();
  // Extensionless files with well-known names.
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'make';
  const ext = lower.split('.').pop() ?? '';
  return EXT_TO_LANG[ext] ?? '';
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
    if (folder.loading) return; // a fetch is already in flight

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
  }, [entry, sessionId, folder.expanded, folder.children, folder.loading]);

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
          <span className={`ftree-chevron ${folder.expanded ? 'is-open' : ''}`}>
            {folder.loading ? (
              <Spinner size={12} />
            ) : (
              <ChevronIcon size={12} className="ftree-chevron-icon" />
            )}
          </span>
          <span className="ftree-icon">
            {folder.expanded ? (
              <FolderOpenIcon size={15} className="ftree-icon-svg ftree-icon-folder" />
            ) : (
              <FolderIcon size={15} className="ftree-icon-svg ftree-icon-folder" />
            )}
          </span>
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
      {/* Empty disclosure gutter so file icons line up with folder icons at the
          same depth (the chevron sits in this gutter, to the left of the icon). */}
      <span className="ftree-chevron ftree-chevron-spacer" aria-hidden="true" />
      <span className="ftree-icon"><FileTypeIcon name={entry.name} /></span>
      <span className="ftree-name">{entry.name}</span>
      {entry.size != null && (
        <span className="ftree-size">{formatSize(entry.size)}</span>
      )}
    </div>
  );
}

/** File preview modal - shows text content or image in a centered overlay. */
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

  // Close on backdrop click.
  const onBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fpreview-backdrop" onClick={onBackdropClick}>
      <div className="fpreview-modal">
        <div className="fpreview-header">
          <span className="fpreview-name" title={preview.path}>
            {preview.name}
          </span>
          <button
            className="fpreview-dl"
            onClick={download}
            title="Download file"
            aria-label="Download file"
          >
            <DownloadIcon size={14} />
          </button>
          <button
            className="fpreview-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>
        <div className="fpreview-body">
          {preview.loading && <div className="ftree-loading">Loading…</div>}
          {preview.error && <div className="ftree-error">{preview.error}</div>}
          {!preview.loading && !preview.error && preview.isImage && (
            <img
              src={api.previewUrl(sessionId, preview.path)}
              alt={preview.name}
              className="fpreview-image"
            />
          )}
          {!preview.error && preview.isPdf && (
            <iframe
              src={api.previewUrl(sessionId, preview.path)}
              title={preview.name}
              className="fpreview-pdf"
            />
          )}
          {!preview.loading && !preview.error && !preview.isImage && !preview.isPdf && preview.highlightedHtml && (
            <div
              className="fpreview-highlighted"
              dangerouslySetInnerHTML={{ __html: preview.highlightedHtml }}
            />
          )}
          {!preview.loading && !preview.error && !preview.isImage && !preview.isPdf && !preview.highlightedHtml && preview.content !== null && (
            <pre className="fpreview-code">{preview.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** Workspace file tree panel with lazy folder expansion, preview, and download. */
export function FileTree({ sessionId, onClose }: FileTreeProps) {
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
      const pdf = isPdfFile(entry.name);
      setPreview({
        path: entry.path,
        name: entry.name,
        content: null,
        highlightedHtml: null,
        isImage: image,
        isPdf: pdf,
        loading: !image && !pdf, // images/PDFs render via their own element
        error: null,
      });

      // For text files, fetch the content and highlight it.
      if (!image && !pdf) {
        try {
          const url = api.previewUrl(sessionId, entry.path);
          const res = await fetch(url, { credentials: 'same-origin' });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(body || `HTTP ${res.status}`);
          }
          const text = await res.text();

          // Attempt syntax highlighting (grammar loaded lazily on demand).
          let html: string | null = null;
          const lang = langFromFilename(entry.name);
          if (lang) html = await highlightToHtml(text, lang);

          setPreview((p) =>
            p && p.path === entry.path
              ? { ...p, content: text, highlightedHtml: html, loading: false }
              : p,
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
          <RefreshIcon size={14} />
        </button>
        {onClose && (
          <button
            className="ftree-close"
            onClick={onClose}
            title="Close file tree"
            aria-label="Close file tree"
          >
            <CloseIcon size={15} />
          </button>
        )}
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

      {preview && (
        <FilePreview preview={preview} sessionId={sessionId} onClose={closePreview} />
      )}
    </div>
  );
}
