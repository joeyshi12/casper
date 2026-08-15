import type { SessionSummary } from '@casper/shared';

// The server orders by updatedAt descending (localeCompare on ISO strings); match it.
const byRecent = (a: SessionSummary, b: SessionSummary) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Fold a session's own summary into the list, replacing any row for it. Opening a session
 * gives us its title before the next list fetch does, so the sidebar and header can show it
 * straight away instead of a placeholder.
 */
export function upsertSession(
  sessions: SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] {
  return [...sessions.filter((s) => s.sessionId !== summary.sessionId), summary].sort(byRecent);
}

/**
 * Float a session to the top on its own turn starting, before the server has persisted the
 * new timestamp. Pure, so the ordering is testable standalone.
 */
export function bumpSessionToTop(
  sessions: SessionSummary[],
  sessionId: string,
  updatedAt: string,
): SessionSummary[] {
  const row = sessions.find((s) => s.sessionId === sessionId);
  return row ? upsertSession(sessions, { ...row, updatedAt }) : sessions;
}
