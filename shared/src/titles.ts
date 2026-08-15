import { stripAttachmentsLine } from './attachments.js';
import type { PromptContentBlock } from './acp.js';

/** Longest title worth showing in the sidebar before it is cut off anyway. */
const MAX_TITLE = 60;

/**
 * A session title from its first prompt. Empty when the prompt has no words to use - an image
 * with no text - so the caller can leave any existing name alone rather than blanking it.
 */
export function titleFromPrompt(content: PromptContentBlock[]): string {
  const text = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // The attachments line is machine-facing, and would otherwise become the title of
  // every message sent with a file.
  const words = stripAttachmentsLine(text)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code says nothing about the topic
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';

  if (words.length <= MAX_TITLE) return words.replace(/[.,;:!?]+$/, '');
  // Cut at a word boundary rather than mid-word, then mark the cut.
  const cut = words.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > MAX_TITLE / 2 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?]+$/, '')}…`;
}

/** A title fit to store, from anywhere: one line, trimmed, capped at what the sidebar shows. */
export function sanitizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** A session with no name and no content yet. */
const UNNAMED_SESSION = 'New session';

/**
 * The one decision about what a session is called, so it cannot read one way in the sidebar
 * and another in the header, or rename itself on going dormant. In order: a Casper title (a
 * rename, or one supplied at creation), kiro's own title, the first prompt, the folder it
 * works in. Anything left has no name and no content, so it is a new session.
 */
export function resolveSessionTitle(parts: {
  override?: string;
  kiroTitle?: string;
  firstPrompt?: string;
  folder?: string;
}): string {
  return (
    sanitizeTitle(parts.override ?? '') ||
    sanitizeTitle(parts.kiroTitle ?? '') ||
    titleFromPrompt(parts.firstPrompt ? [{ type: 'text', text: parts.firstPrompt }] : []) ||
    sanitizeTitle(parts.folder ?? '') ||
    UNNAMED_SESSION
  );
}
