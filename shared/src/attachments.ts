// Uploaded files are announced to the agent with a single compact line so the
// model knows where they live in the workspace. The web client parses this line
// to render image thumbnails from the saved paths, and strips it from the
// displayed message bubble (the raw line is only meant for the model).

export const ATTACHMENTS_PREFIX = 'Attached files: ';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'];

/** Relative workspace paths from the "Attached files:" line, or []. */
export function attachmentPaths(text: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith(ATTACHMENTS_PREFIX));
  if (!line) return [];
  return line
    .slice(ATTACHMENTS_PREFIX.length)
    .split(', ')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Just the image paths among the attachments (for thumbnail rendering). */
export function imageAttachmentPaths(text: string): string[] {
  return attachmentPaths(text).filter((p) => {
    const lower = p.toLowerCase();
    return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
  });
}

/** The message text with the auto-generated attachments line removed. */
export function stripAttachmentsLine(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith(ATTACHMENTS_PREFIX))
    .join('\n')
    .trim();
}
