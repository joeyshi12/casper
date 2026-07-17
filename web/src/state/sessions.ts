import type { SessionSummary } from '@casper/shared';

// Stamp one session's updatedAt and re-sort the list by updatedAt descending,
// matching the server's ordering (updatedAt.localeCompare on ISO strings). Used
// to float the active session to the top of the sidebar the moment a turn
// starts, before the server has persisted the new timestamp. Pure so the
// ordering is unit-testable without the store.
export function bumpSessionToTop(
  sessions: SessionSummary[],
  sessionId: string,
  updatedAt: string,
): SessionSummary[] {
  return sessions
    .map((s) => (s.sessionId === sessionId ? { ...s, updatedAt } : s))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
