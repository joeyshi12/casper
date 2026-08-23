import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageAttachment } from '@casper/shared';
import type { PromptContentBlock, UploadedFile } from '@casper/shared';
import { ATTACHMENTS_PREFIX } from '@casper/shared';
import { useStore } from '../../state/store.js';
import { api } from '../../api/rest.js';
import type { ConnStatus } from '../../api/SessionSocket.js';
import { PlusIcon, ArrowUpIcon, StopIcon, Spinner } from '../common/icons.js';
import { AgentPicker, ModelPicker } from '../controls/Pickers.js';
import { ContextRing } from '../observability/ContextRing.js';
import { composerPlaceholder } from '../../util/composerPlaceholder.js';

/** Image MIME types that can be inlined as ACP image content blocks. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

interface Attachment {
  id: string;
  file: File;
  /** True for images (shown as a thumbnail, inlined as an image block). */
  isImage: boolean;
  /** Object URL for the thumbnail (images only). */
  previewUrl?: string;
}

interface Props {
  /** Active session id - required to upload attachments. */
  /** The chat that owns the uploads directory; present for a draft too. */
  chatId: string | null;
  onSend: (content: PromptContentBlock[], attachments?: MessageAttachment[]) => void;
  onCancel: () => void;
  /** Trigger a /compact of the conversation to reduce context size. */
  onCompact: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeAgent: (modeId: string) => void;
  /** Live socket status - drives the placeholder and whether prompts can send. */
  connStatus: ConnStatus;
  /** Composing the first prompt of a session that does not exist yet. */
  draft?: boolean;
}

/** ChatGPT-style input: + attach inside, paste, auto-grow, upload-on-send. */
export function Composer({
  chatId,
  onSend,
  onCancel,
  onCompact,
  onChangeModel,
  onChangeAgent,
  connStatus,
  draft,
}: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnStatus = useStore((s) => s.observability.turnStatus);
  const compacting = useStore((s) => s.observability.compacting);
  const currentModeId = useStore((s) => s.currentModeId);
  const currentModelId = useStore((s) => s.currentModelId);
  const running = turnStatus === 'running';
  const cancelling = turnStatus === 'cancelling';
  // A draft has no socket: sending is what creates the session, so the connection
  // states below don't apply to it.
  const live = draft || connStatus === 'connected';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

    // 1. Where the files landed: the only way the agent can reach one it isn't handed.
    if (uploaded.length > 0) {
      // Trailing newline keeps this its own line even when the prompt's text blocks are
      // concatenated with no separator, or the line-based strip swallows the typed message.
      content.push({
        type: 'text',
        text: ATTACHMENTS_PREFIX + uploaded.map((u) => u.path).join(', ') + '\n',
      });
    }

    // 2. Images inline, because vision needs the bytes. Everything else stays a path:
    // inlining contents put the whole file in the bubble as if the user had typed it.
    for (let i = 0; i < uploaded.length; i++) {
      const u = uploaded[i];
      const att = atts[i];
      if (!u) continue;
      if (u.kind === 'image' && att) {
        try {
          const data = await readFileAsBase64(att.file);
          // u.mimeType, not att.file.type: the browser leaves File.type empty for plenty of
          // drops, and an image block with an empty mimeType is malformed.
          content.push({ type: 'image', data, mimeType: u.mimeType });
        } catch {
          /* skip unreadable image */
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
      if (!chatId) {
        setError('No chat to upload to.');
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const res = await api.uploadFiles(chatId, atts.map((a) => a.file));
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

    onSend(
      content,
      uploaded.map((u) => ({ path: u.path, name: u.name, size: u.size, kind: u.kind })),
    );
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

  useEffect(() => {
    return () => {
      setAttachments((prev) => {
        prev.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
        return prev;
      });
    };
  }, []);


  const placeholder = composerPlaceholder({
    live,
    connStatus,
    uploading,
    cancelling,
    compacting,
    running,
  });

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
      <div className="composer-box">
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
        <div className="composer-actions">
          <button
            className="composer-plus"
            onClick={() => fileInputRef.current?.click()}
            // A draft has no session to upload to yet, so this waits for the first prompt.
            disabled={draft || !live || uploading}
            title={draft ? 'Send a message first to attach files' : 'Add photos & files'}
            aria-label="Add photos and files"
          >
            <PlusIcon size={18} />
          </button>
          <div className="composer-actions-right">
            <ContextRing onCompact={onCompact} />
            <AgentPicker value={currentModeId} onChange={onChangeAgent} />
            <ModelPicker value={currentModelId} onChange={onChangeModel} />
            {running ? (
              <button
                className="composer-btn composer-stop"
                onClick={onCancel}
                title="Stop"
                aria-label="Stop"
              >
                <StopIcon size={15} />
              </button>
            ) : cancelling ? (
              <button
                className="composer-btn composer-stop"
                disabled
                title="Stopping…"
                aria-label="Stopping"
              >
                <StopIcon size={15} />
              </button>
            ) : (
              <button
                className="composer-btn composer-send"
                onClick={submit}
                disabled={!canSend}
                title={uploading ? 'Uploading…' : 'Send'}
                aria-label={uploading ? 'Uploading' : 'Send'}
              >
                {uploading ? <Spinner size={15} /> : <ArrowUpIcon size={17} />}
              </button>
            )}
          </div>
        </div>
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
