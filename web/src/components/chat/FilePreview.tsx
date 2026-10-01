import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/rest.js';
import { useStore } from '../../state/store.js';
import { highlightToHtml } from '../../util/highlighter.js';
import { langFromFilename, previewKind, type PreviewKind } from '../../util/fileKind.js';
import {
  CloseIcon,
  CodeIcon,
  DownloadIcon,
  ExpandIcon,
  EyeIcon,
  ShrinkIcon,
  Spinner,
} from '../common/icons.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

/**
 * The file preview, for the file tree or a read/write tool call in the transcript.
 * Portalled to the body like the app's other modals - a `transform` on an ancestor
 * becomes the containing block for `position: fixed`, and the mobile panel is
 * transformed.
 */

interface PreviewState {
  path: string;
  name: string;
  content: string | null;
  highlightedHtml: string | null;
  kind: PreviewKind;
  loading: boolean;
  error: string | null;
}

const basename = (p: string): string => p.split('/').pop() || p;

function PreviewModal({
  preview,
  chatId,
  onClose,
}: {
  preview: PreviewState;
  chatId: string;
  onClose: () => void;
}) {
  // A class rather than the Fullscreen API, which iOS Safari won't grant to arbitrary elements.
  const [full, setFull] = useState(false);
  const [sourceByPath, setSourceByPath] = useState<Record<string, boolean>>({});

  const download = () => {
    window.open(api.downloadUrl(chatId, preview.path), '_blank');
  };

  const onBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const showSource = sourceByPath[preview.path] ?? false;
  const canRender = preview.kind === 'html' || preview.kind === 'markdown';
  const showRendered = canRender && !showSource;
  const showText = preview.kind !== 'image' && preview.kind !== 'pdf' && !showRendered;

  return (
    <div className="fpreview-backdrop" onClick={onBackdropClick}>
      <div className={`fpreview-modal${full ? ' fpreview-full' : ''}`}>
        <div className="fpreview-header">
          {canRender && !preview.error && (
            <div className="fpreview-seg" role="group" aria-label="Preview mode">
              <button
                className={`fpreview-seg-btn${showSource ? '' : ' is-active'}`}
                onClick={() => setSourceByPath((prev) => ({ ...prev, [preview.path]: false }))}
                title="Rendered"
                aria-label="Rendered"
                aria-pressed={!showSource}
              >
                <EyeIcon size={17} />
              </button>
              <button
                className={`fpreview-seg-btn${showSource ? ' is-active' : ''}`}
                onClick={() => setSourceByPath((prev) => ({ ...prev, [preview.path]: true }))}
                title="Source"
                aria-label="Source"
                aria-pressed={showSource}
              >
                <CodeIcon size={17} />
              </button>
            </div>
          )}
          <span className="fpreview-name" title={preview.path}>
            {preview.name}
          </span>
          <button
            className="fpreview-dl"
            onClick={download}
            title="Download file"
            aria-label="Download file"
          >
            <DownloadIcon size={18} />
          </button>
          <button
            className="fpreview-full-btn"
            onClick={() => setFull((v) => !v)}
            title={full ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={full ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {full ? <ShrinkIcon size={18} /> : <ExpandIcon size={18} />}
          </button>
          <button className="fpreview-close" onClick={onClose} aria-label="Close preview">
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="fpreview-body">
          {preview.loading && (
            <div className="fpreview-loading">
              <Spinner size={48} />
            </div>
          )}
          {preview.error && <div className="ftree-error">{preview.error}</div>}
          {!preview.loading && !preview.error && preview.kind === 'image' && (
            <img
              src={api.previewUrl(chatId, preview.path)}
              alt={preview.name}
              className="fpreview-image"
            />
          )}
          {!preview.error && preview.kind === 'pdf' && (
            <iframe
              src={api.previewUrl(chatId, preview.path)}
              title={preview.name}
              className="fpreview-pdf"
            />
          )}
          {!preview.error && preview.kind === 'html' && showRendered && (
            // No allow-same-origin: scripts run but the page can't reach the session
            // cookie or the API. The server sends a matching CSP.
            <iframe
              src={`${api.previewUrl(chatId, preview.path)}&raw=1`}
              title={preview.name}
              className="fpreview-html"
              sandbox="allow-scripts allow-forms"
            />
          )}
          {!preview.loading && !preview.error && preview.kind === 'markdown' && showRendered && preview.content !== null && (
            <div className="fpreview-md">
              <MarkdownRenderer text={preview.content} html />
            </div>
          )}
          {!preview.loading && !preview.error && showText && preview.highlightedHtml && (
            <div
              className="fpreview-highlighted"
              dangerouslySetInnerHTML={{ __html: preview.highlightedHtml }}
            />
          )}
          {!preview.loading && !preview.error && showText && !preview.highlightedHtml && preview.content !== null && (
            <pre className="fpreview-code">{preview.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function FilePreview() {
  const path = useStore((s) => s.previewPath);
  const chatId = useStore((s) => s.activeId);
  const closeFilePreview = useStore((s) => s.closeFilePreview);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const close = useCallback(() => closeFilePreview(), [closeFilePreview]);

  // `stale` guards against a second file opening while the first is still in flight.
  useEffect(() => {
    if (!path || !chatId) {
      setPreview(null);
      return;
    }
    let stale = false;
    const kind = previewKind(basename(path));
    const needsContent = kind !== 'image' && kind !== 'pdf';
    setPreview({
      path,
      name: basename(path),
      content: null,
      highlightedHtml: null,
      kind,
      loading: needsContent,
      error: null,
    });
    if (!needsContent) return;

    void (async () => {
      try {
        const res = await fetch(api.previewUrl(chatId, path), { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        const text = await res.text();
        if (stale) return;
        setPreview((p) => (p && p.path === path ? { ...p, content: text, loading: false } : p));

        const lang = langFromFilename(basename(path));
        if (!lang) return;
        const html = await highlightToHtml(text, lang);
        if (stale || !html) return;
        setPreview((p) => (p && p.path === path ? { ...p, highlightedHtml: html } : p));
      } catch (err) {
        if (stale) return;
        setPreview((p) =>
          p && p.path === path
            ? { ...p, loading: false, error: err instanceof Error ? err.message : 'Could not read the file' }
            : p,
        );
      }
    })();

    return () => {
      stale = true;
    };
  }, [path, chatId]);

  if (!preview || !chatId) return null;
  return createPortal(
    <PreviewModal preview={preview} chatId={chatId} onClose={close} />,
    document.body,
  );
}
