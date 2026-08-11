/** Owns the session URL shape: the route pattern and the paths that match it. */
const SESSIONS = '/sessions';

export const SESSION_ROUTE = `${SESSIONS}/:sessionId`;

export function pathForSession(id: string): string {
  return `${SESSIONS}/${encodeURIComponent(id)}`;
}
