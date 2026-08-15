import type { SessionSummary } from '@casper/shared';

// Stamp one session's updatedAt and re-sort by it descending, matching the server's
// ordering. Floats the active session to the top the moment a turn starts, before the
// server has persisted the new timestamp. Pure, so the ordering is testable standalone.
export function bumpSessionToTop(
  sessions: SessionSummary[],
  sessionId: string,
  updatedAt: string,
): SessionSummary[] {
  return sessions
    .map((s) => (s.sessionId === sessionId ? { ...s, updatedAt } : s))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
