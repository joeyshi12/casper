// Uploaded files are announced to the agent with one compact line, because a path is the
// only way it can reach a file the prompt doesn't inline. The line is stripped from the
// displayed bubble; what the transcript shows comes from Casper's own attachment record,
// not from parsing this back out.

export const ATTACHMENTS_PREFIX = 'Attached files: ';

/** The message text with the auto-generated attachments line removed. */
export function stripAttachmentsLine(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith(ATTACHMENTS_PREFIX))
    .join('\n')
    .trim();
}
