import { db } from './db.js';

/**
 * Per-session overrides Casper layers over kiro's own session files: a title the
 * user renamed to, and a working directory they re-pointed at.
 *
 * Both are keyed by session id and were previously two separate JSON files, which
 * meant every read site had to consult two stores and every delete had to
 * remember both. One row per session instead, so a new override is a column.
 *
 * Overrides only, so an absent row (or a NULL column) means "whatever kiro says",
 * which is why the getters return undefined rather than a default.
 */
export class SessionStore {
  getTitle(sessionId: string): string | undefined {
    return this.read(sessionId, 'title');
  }

  setTitle(sessionId: string, title: string): void {
    this.write(sessionId, 'title', title);
  }

  getCwd(sessionId: string): string | undefined {
    return this.read(sessionId, 'cwd');
  }

  setCwd(sessionId: string, cwd: string): void {
    this.write(sessionId, 'cwd', cwd);
  }

  /** Forget every override for a session, when it's permanently deleted. */
  remove(sessionId: string): void {
    db().prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  private read(sessionId: string, column: 'title' | 'cwd'): string | undefined {
    const row = db()
      .prepare(`SELECT ${column} AS value FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  private write(sessionId: string, column: 'title' | 'cwd', value: string): void {
    db()
      .prepare(
        `INSERT INTO sessions (session_id, ${column}) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET ${column} = excluded.${column}`,
      )
      .run(sessionId, value);
  }
}
