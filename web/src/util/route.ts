/** Owns the session URL shape: the route pattern and the paths that match it. */
const SESSIONS = '/sessions';

export const SESSION_ROUTE = `${SESSIONS}/:sessionId`;

export function pathForSession(id: string): string {
  return `${SESSIONS}/${encodeURIComponent(id)}`;
}

/** A session the user is composing but the server has not been told about yet. */
export const DRAFT_PATH = `${SESSIONS}/new`;
