import { stripAttachmentsLine } from '@casper/shared';
import type { PromptContentBlock } from '@casper/shared';

/** Longest title worth showing in the sidebar before it is cut off anyway. */
const MAX_TITLE = 60;

/**
 * A session title taken from its first prompt, the way every chat app names a conversation.
 * Empty when the prompt has no words to use - an image with no text, say - so the caller can
 * leave the existing name alone rather than blanking it. kiro derives its own title only once
 * a turn completes; this makes the row readable while the first one runs.
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
