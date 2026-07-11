import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptContentBlock } from '@casper/shared';
import { useStore } from '../../state/store.js';

/** Image MIME types that can be sent as ImageContentBlock. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/** Max attachment size (10 MB). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface Attachment {
  id: string;
  file: File;
  /** Base64-encoded data for images. */
  data?: string;
  /** Text content for non-image files. */
  textContent?: string;
  /** Whether this is an image attachment. */
  isImage: boolean;
  /** Preview URL for image display. */
  previewUrl?: string;
}

interface Props {
  onSend: (content: PromptContentBlock[]) => void;
  onCancel: () => void;
  /** True once the session's socket is connected and ready to accept prompts. */
  live: boolean;
}

/** ChatGPT-style message input with + attach inside, paste support, auto-grow. */
export function Composer({ onSend, onCancel, live }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const running = useStore((s) => s.observability.turnStatus === 'running');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] ?? '';
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  // Auto-resize textarea to fit content.
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const addFiles = useCallback(async (files: File[]) => {
    const newAttachments: Attachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;

      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const isImage = IMAGE_TYPES.has(file.type);

      if (isImage) {
        const previewUrl = URL.createObjectURL(file);
        const data = await readFileAsBase64(file);
        newAttachments.push({ id, file, data, isImage: true, previewUrl });
      } else {
        try {
          const textContent = await file.text();
          newAttachments.push({ id, file, textContent, isImage: false });
        } catch {
          // Skip files that can't be read as text.
        }
      }
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || running || !live) return;

    const content: PromptContentBlock[] = [];

    for (const att of attachments) {
      if (att.isImage) {
        const data = att.data ?? (await readFileAsBase64(att.file));
        content.push({ type: 'image', data, mimeType: att.file.type });
      } else if (att.textContent != null) {
        content.push({
          type: 'text',
          text: `[File: ${att.file.name}]\n\`\`\`\n${att.textContent}\n\`\`\``,
        });
      }
    }

    if (trimmed) {
      content.push({ type: 'text', text: trimmed });
    }

    onSend(content);
    setText('');
    setAttachments([]);
    // Reset height after clearing.
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Handle paste: detect images from clipboard.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && IMAGE_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles],
  );

  const onAttach = () => {
    fileInputRef.current?.click();
  };

  const onFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    await addFiles(Array.from(files));
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const placeholder = !live
    ? 'Connecting…'
    : running
      ? 'Casper is working…'
      : 'Ask Casper to build something…';

  const canSend = (text.trim() || attachments.length > 0) && !running && live;

  return (
    <div className="composer">
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
        <button
          className="composer-plus"
          onClick={onAttach}
          disabled={running || !live}
          title="Attach file"
          aria-label="Attach file"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
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
        ) : (
          <button
            className="composer-btn composer-send"
            onClick={submit}
            disabled={!canSend}
          >
            Send
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
