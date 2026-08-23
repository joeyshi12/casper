import { useCallback, useEffect, useState, useRef } from 'react';
import type { FileEntry } from '@casper/shared';
import { api } from '../../api/rest.js';
import { formatSize } from '../../util/formatSize.js';
import { useStore } from '../../state/store.js';
import { ChangeFolderSheet } from '../sessions/ChangeFolderSheet.js';
import {
  ChevronIcon,
  CloseIcon,
  FileCodeIcon,
  FileConfigIcon,
  FileIcon,
  FileImageIcon,
  FileStyleIcon,
  FileTerminalIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  Spinner,
} from '../common/icons.js';

interface FileTreeProps {
  chatId: string;
  /** Collapse the panel. Used by the mobile close button, where the header
   *  toggle is covered by the panel overlay. */
  onClose?: () => void;
}

interface FolderState {
  expanded: boolean;
  children: FileEntry[] | null;
  loading: boolean;
}

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

function TreeEntry({
  entry,
  chatId,
  depth,
  onPreview,
  onExpanded,
}: {
  entry: FileEntry;
  chatId: string;
  depth: number;
  onPreview: (entry: FileEntry) => void;
  onExpanded: (path: string, expanded: boolean) => void;
}) {
  const changed = useStore((st) => st.fsVersion[entry.path] ?? 0);
  const [folder, setFolder] = useState<FolderState>({
    expanded: false,
    children: null,
    loading: false,
  });

  useEffect(() => {
    if (entry.type !== 'directory') return;
    onExpanded(entry.path, folder.expanded);
    return () => onExpanded(entry.path, false);
  }, [entry.path, entry.type, folder.expanded, onExpanded]);

  // The server reported this directory changed, so re-list it. Only this row
  // reloads, which is why the rest of the tree keeps its expansion.
  useEffect(() => {
    if (!changed || !folder.expanded) return;
    let live = true;
    api
      .tree(chatId, entry.path)
      .then((res) => {
        if (live) setFolder((f) => ({ ...f, children: res.entries }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);

  const toggle = useCallback(async () => {
    if (entry.type !== 'directory') return;
    if (folder.loading) return; // a fetch is already in flight

    if (folder.expanded) {
      setFolder((f) => ({ ...f, expanded: false }));
      return;
    }

    if (folder.children === null) {
      setFolder((f) => ({ ...f, loading: true }));
      try {
        const res = await api.tree(chatId, entry.path);
        setFolder({ expanded: true, children: res.entries, loading: false });
      } catch {
        setFolder((f) => ({ ...f, loading: false }));
      }
    } else {
      setFolder((f) => ({ ...f, expanded: true }));
    }
  }, [entry, chatId, folder.expanded, folder.children, folder.loading]);

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
                chatId={chatId}
                depth={depth + 1}
                onPreview={onPreview}
                onExpanded={onExpanded}
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

/** Workspace file tree panel with lazy folder expansion, preview, and download. */
export function FileTree({ chatId, onClose }: FileTreeProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [cwd, setCwd] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changingFolder, setChangingFolder] = useState(false);
  const sessions = useStore((s) => s.chats);
  const setWatchedPaths = useStore((st) => st.setWatchedPaths);
  const rootChanged = useStore((st) => st.fsVersion[''] ?? 0);
  const expandedRef = useRef<Set<string>>(new Set());
  const setChats = useStore((s) => s.setChats);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const summaryCwd = sessions.find((s) => s.chatId === chatId)?.cwd;

  // Watch the root plus every expanded directory: exactly what the tree can show,
  // so the server holds a handful of watches instead of the whole workspace.
  const publish = useCallback(() => {
    setWatchedPaths(['', ...expandedRef.current]);
  }, [setWatchedPaths]);

  const onExpanded = useCallback(
    (path: string, expanded: boolean) => {
      const set = expandedRef.current;
      if (expanded === set.has(path)) return;
      if (expanded) set.add(path);
      else set.delete(path);
      publish();
    },
    [publish],
  );

  // This component mounts when the panel opens, so the set is declared then and
  // dropped when it closes.
  useEffect(() => {
    publish();
    return () => setWatchedPaths([]);
  }, [publish, setWatchedPaths]);

  // A background re-list happens because the directory changed on disk, so it must
  // not disturb what is on screen: no placeholder, and the rows stay mounted, which
  // is what keeps folders open.
  const refresh = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      setError(null);
      try {
        const res = await api.tree(chatId);
        setEntries(res.entries);
        setCwd(res.cwd);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!background) setLoading(false);
      }
    },
    [chatId],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The top level, on the same signal a folder row uses.
  useEffect(() => {
    if (rootChanged) void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootChanged]);



  return (
    <div className="ftree-panel">
      <div className="ftree-header">
        <span className="ftree-title" title={cwd}>
          Files
        </span>
        <button
          className="ftree-refresh"
          onClick={() => setChangingFolder(true)}
          title="Change working directory"
          aria-label="Change working directory"
        >
          <FolderIcon size={14} />
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
        {loading && entries.length === 0 && (
          <div className="ftree-loading">Loading…</div>
        )}
        {error && (
          <div className="ftree-error">
            {error}
            <button className="ftree-repoint" onClick={() => setChangingFolder(true)}>
              Change folder…
            </button>
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="ftree-empty">No files</div>
        )}
        {!error &&
          entries.map((entry) => (
            <TreeEntry
              key={entry.path}
              entry={entry}
              chatId={chatId}
              depth={0}
              onPreview={(entry) => openFilePreview(entry.path)}
              onExpanded={onExpanded}
            />
          ))}
      </div>

      {changingFolder && (
        <ChangeFolderSheet
          chatId={chatId}
          // The tree request fails when the folder is gone, so fall back to the
          // cwd from the session list to prefill the input.
          currentCwd={cwd || summaryCwd}
          onChanged={(next) => {
            setChats(
              sessions.map((s) =>
                s.chatId === chatId ? { ...s, cwd: next } : s,
              ),
            );
            refresh();
          }}
          onClose={() => setChangingFolder(false)}
        />
      )}
    </div>
  );
}
