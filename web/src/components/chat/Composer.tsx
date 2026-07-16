import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptContentBlock, UploadedFile } from '@casper/shared';
import { ATTACHMENTS_PREFIX } from '@casper/shared';
import { useStore } from '../../state/store.js';
import { api } from '../../api/rest.js';
import type { ConnStatus } from '../../api/SessionSocket.js';
import { PlusIcon, PaperclipIcon, CompressIcon } from '../common/icons.js';

/** Image MIME types that can be inlined as ACP image content blocks. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

export interface Attachment {
  id: string;
  file: File;
  /** True for images (shown as a thumbnail, inlined as an image block). */
  isImage: boolean;
  /** Object URL for the thumbnail (images only). */
  previewUrl?: string;
}

interface Props {
  /** Active session id - required to upload attachments. */
  sessionId: string | null;
  onSend: (content: PromptContentBlock[]) => void;
  onCancel: () => void;
  /** Trigger a /compact of the conversation to reduce context size. */
  onCompact: () => void;
  /** Live socket status - drives the placeholder and whether prompts can send. */
  connStatus: ConnStatus;
}

/** ChatGPT-style input: + attach inside, paste, auto-grow, upload-on-send. */
export function Composer({ sessionId, onSend, onCancel, onCompact, connStatus }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const compacting = useStore((s) => s.observability.compacting);
  const running = turnStatus === 'running';
  const cancelling = turnStatus === 'cancelling';
  const live = connStatus === 'connected';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const addFiles = useCallback((files: File[]) => {
    const next: Attachment[] = files.map((file) => {
      const isImage = IMAGE_TYPES.has(file.type);
      return {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        isImage,
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      };
    });
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  /** Turn upload metadata + local files into ACP content blocks. */
  const buildContent = async (
    uploaded: UploadedFile[],
    atts: Attachment[],
    typed: string,
  ): Promise<PromptContentBlock[]> => {
    const content: PromptContentBlock[] = [];

    // 1. One compact line telling the agent where the files landed. The client
    // strips this from the displayed bubble and renders image thumbnails from
    // these paths instead (see shared/attachments).
    if (uploaded.length > 0) {
      // Trailing newline keeps this a distinct line even when the prompt's text
      // blocks are concatenated with no separator (the store's turn_started echo
      // and hydrateTranscript join with ''); otherwise the line-based
      // stripAttachmentsLine would swallow the typed message too.
      content.push({
        type: 'text',
        text: ATTACHMENTS_PREFIX + uploaded.map((u) => u.path).join(', ') + '\n',
      });
    }

    // 2. Inline images (base64) and text-file contents.
    for (let i = 0; i < uploaded.length; i++) {
      const u = uploaded[i];
      const att = atts[i];
      if (!u) continue;
      if (u.kind === 'image' && att) {
        try {
          const data = await readFileAsBase64(att.file);
          content.push({ type: 'image', data, mimeType: att.file.type });
        } catch {
          /* skip unreadable image */
        }
      } else if (u.kind === 'text' && att) {
        try {
          const body = await att.file.text();
          content.push({ type: 'text', text: `[File: ${u.path}]\n\`\`\`\n${body}\n\`\`\`` });
        } catch {
          /* skip unreadable text */
        }
      }
    }

    // 3. The user's typed message last.
    if (typed) content.push({ type: 'text', text: typed });
    return content;
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (
      (!trimmed && attachments.length === 0) ||
      running ||
      cancelling ||
      compacting ||
      !live ||
      uploading
    )
      return;

    let uploaded: UploadedFile[] = [];
    const atts = attachments;

    if (atts.length > 0) {
      if (!sessionId) {
        setError('No active session to upload to.');
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const res = await api.uploadFiles(sessionId, atts.map((a) => a.file));
        uploaded = res.files;
      } catch (err) {
        setError((err as Error).message);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const content = await buildContent(uploaded, atts, trimmed);
    if (content.length === 0) return;

    onSend(content);
    setText('');
    atts.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && IMAGE_TYPES.has(item.type)) {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles],
  );

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  // Revoke any outstanding object URLs on unmount.
  useEffect(() => {
    return () => {
      setAttachments((prev) => {
        prev.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
        return prev;
      });
    };
  }, []);

  // Close the + menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const placeholder =
    connStatus === 'closed'
      ? 'Offline - reconnecting when possible'
      : connStatus === 'reconnecting'
        ? 'Reconnecting…'
        : connStatus === 'resyncing'
          ? 'Resyncing…'
          : !live
            ? 'Connecting…'
            : uploading
              ? 'Uploading…'
              : cancelling
                ? 'Stopping…'
                : compacting
                  ? 'Compacting conversation…'
                  : running
                    ? 'Casper is working…'
                    : 'Ask Casper to build something…';

  const canSend =
    (text.trim() || attachments.length > 0) &&
    !running &&
    !cancelling &&
    !compacting &&
    !uploading &&
    live;

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((att) => (
            <div key={att.id} className="composer-att">
              {att.isImage && att.previewUrl ? (
                <img src={att.previewUrl} alt={att.file.name} className="composer-att-img" />
              ) : (
                <div className="composer-att-file" title={att.file.name}>
                  <span className="composer-att-file-icon">📄</span>
                  <span className="composer-att-file-name">{att.file.name}</span>
                </div>
              )}
              <button
                className="composer-att-remove"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Remove ${att.file.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-input-box">
        <div className="composer-menu-wrap" ref={menuRef}>
          <button
            className="composer-plus"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={!live || uploading}
            title="Add"
            aria-label="Add"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <PlusIcon size={18} />
          </button>
          {menuOpen && (
            <div className="composer-menu" role="menu">
              <button
                className="composer-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                <PaperclipIcon size={16} className="composer-menu-icon" />
                <span className="composer-menu-label">Add photos &amp; files</span>
              </button>
              <button
                className="composer-menu-item"
                role="menuitem"
                disabled={!sessionId || running || cancelling || compacting}
                onClick={() => {
                  setMenuOpen(false);
                  onCompact();
                }}
              >
                <CompressIcon size={16} className="composer-menu-icon" />
                <span className="composer-menu-label">Compact conversation</span>
              </button>
            </div>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={1}
        />
        {running ? (
          <button className="composer-btn composer-stop" onClick={onCancel}>
            Stop
          </button>
        ) : cancelling ? (
          <button className="composer-btn composer-stop" disabled>
            Stopping…
          </button>
        ) : (
          <button className="composer-btn composer-send" onClick={submit} disabled={!canSend}>
            {uploading ? '…' : 'Send'}
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={onFileSelect}
        className="composer-file-input"
      />
    </div>
  );
}
