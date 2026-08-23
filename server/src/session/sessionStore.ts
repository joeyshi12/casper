import type { MessageAttachment } from '@casper/shared';
import { db } from './db.js';

/**
 * Per-session overrides Casper layers over kiro's own session files: a renamed
 * title and a re-pointed working directory, one row each.
 *
 * These are overrides only, so an absent row or NULL column means "whatever kiro
 * says" - hence undefined rather than a default from the getters.
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

  /** Record what was attached to one prompt. See db.ts for why the key is an ordinal. */
  setAttachments(sessionId: string, ordinal: number, files: MessageAttachment[]): void {
    if (files.length === 0) return;
    const stmt = db().prepare(
      `INSERT INTO message_attachments (session_id, ordinal, path, name, size, kind)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ordinal, path) DO NOTHING`,
    );
    for (const f of files) {
      stmt.run(sessionId, ordinal, f.path, f.name, f.size, f.kind);
    }
  }

  /** Every attachment in a session, grouped by the message it belongs to. */
  attachmentsBySession(sessionId: string): Map<number, MessageAttachment[]> {
    const rows = db()
      .prepare(
        `SELECT ordinal, path, name, size, kind FROM message_attachments
         WHERE session_id = ? ORDER BY ordinal, path`,
      )
      .all(sessionId) as { ordinal: number; path: string; name: string; size: number; kind: string }[];
    const out = new Map<number, MessageAttachment[]>();
    for (const r of rows) {
      const list = out.get(r.ordinal) ?? [];
      list.push({
        path: r.path,
        name: r.name,
        size: r.size,
        kind: r.kind as MessageAttachment['kind'],
      });
      out.set(r.ordinal, list);
    }
    return out;
  }

  /** Forget every override for a session, when it's permanently deleted. */
  remove(sessionId: string): void {
    db().prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    db().prepare('DELETE FROM message_attachments WHERE session_id = ?').run(sessionId);
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
