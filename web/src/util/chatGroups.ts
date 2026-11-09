import type { ChatSummary } from '@casper/shared';

export interface ChatGroup {
  label: string;
  chats: ChatSummary[];
}

const DAY = 24 * 60 * 60 * 1000;

/** Splits chats by when they were last active, counting days from local midnight. Keeps
 *  the order the chats arrive in, and leaves out empty groups. */
export function groupByDate(chats: ChatSummary[], now: Date = new Date()): ChatGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t = today.getTime();
  const groups: ChatGroup[] = [
    { label: 'Today', chats: [] },
    { label: 'Yesterday', chats: [] },
    { label: 'Previous 7 days', chats: [] },
    { label: 'Previous 30 days', chats: [] },
    { label: 'Older', chats: [] },
  ];
  for (const c of chats) {
    const at = Date.parse(c.updatedAt);
    const i = at >= t ? 0 : at >= t - DAY ? 1 : at >= t - 7 * DAY ? 2 : at >= t - 30 * DAY ? 3 : 4;
    groups[i]!.chats.push(c);
  }
  return groups.filter((g) => g.chats.length > 0);
}
