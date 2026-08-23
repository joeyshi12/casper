import type { MessageAttachment } from '@casper/shared';
import { db } from './db.js';

type ChatColumn = 'title' | 'cwd' | 'session_id';

export interface ChatRow {
  chatId: string;
  sessionId: string | null;
  title: string | null;
  cwd: string | null;
}

/**
 * A chat is a conversation Casper started. The row is Casper's own: kiro's session file holds
 * the transcript, and this holds the chat's identity plus the title and working directory
 * Casper layers over it. Anything in kiro's sessions directory without a row here - a subagent,
 * or a session started with kiro-cli - is not a chat and is not listed.
 */
export class ChatStore {
  /** Every chat. Ordering is kiro's business, applied once the file is joined on. */
  all(): ChatRow[] {
    return (
      db()
        .prepare('SELECT chat_id, session_id, title, cwd FROM chats')
        .all() as { chat_id: string; session_id: string | null; title: string | null; cwd: string | null }[]
    ).map((r) => ({ chatId: r.chat_id, sessionId: r.session_id, title: r.title, cwd: r.cwd }));
  }

  get(chatId: string): ChatRow | undefined {
    const r = db()
      .prepare('SELECT chat_id, session_id, title, cwd FROM chats WHERE chat_id = ?')
      .get(chatId) as
      | { chat_id: string; session_id: string | null; title: string | null; cwd: string | null }
      | undefined;
    return r
      ? { chatId: r.chat_id, sessionId: r.session_id, title: r.title, cwd: r.cwd }
      : undefined;
  }

  create(chatId: string): void {
    db()
      .prepare('INSERT INTO chats (chat_id) VALUES (?) ON CONFLICT(chat_id) DO NOTHING')
      .run(chatId);
  }

  /**
   * kiro names the session once it starts one; bind it to the chat that owns it. A session
   * belongs to exactly one chat, so any earlier claim on it is released.
   */
  bindSession(chatId: string, sessionId: string): void {
    db()
      .prepare('UPDATE chats SET session_id = NULL WHERE session_id = ? AND chat_id <> ?')
      .run(sessionId, chatId);
    this.write(chatId, 'session_id', sessionId);
  }

  sessionIdForChat(chatId: string): string | undefined {
    const row = db()
      .prepare('SELECT session_id FROM chats WHERE chat_id = ?')
      .get(chatId) as { session_id: string | null } | undefined;
    return row?.session_id ?? undefined;
  }

  getTitle(chatId: string): string | undefined {
    return this.read(chatId, 'title');
  }

  setTitle(chatId: string, title: string): void {
    this.write(chatId, 'title', title);
  }

  getCwd(chatId: string): string | undefined {
    return this.read(chatId, 'cwd');
  }

  setCwd(chatId: string, cwd: string): void {
    this.write(chatId, 'cwd', cwd);
  }

  /** Record what was attached to one prompt. See db.ts for why the key is an ordinal. */
  setAttachments(chatId: string, ordinal: number, files: MessageAttachment[]): void {
    if (files.length === 0) return;
    const stmt = db().prepare(
      `INSERT INTO message_attachments (chat_id, ordinal, path, name, size, kind)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, ordinal, path) DO NOTHING`,
    );
    for (const f of files) {
      stmt.run(chatId, ordinal, f.path, f.name, f.size, f.kind);
    }
  }

  /** Every attachment in a chat, grouped by the message it belongs to. */
  attachmentsByChat(chatId: string): Map<number, MessageAttachment[]> {
    const rows = db()
      .prepare(
        `SELECT ordinal, path, name, size, kind FROM message_attachments
         WHERE chat_id = ? ORDER BY ordinal, path`,
      )
      .all(chatId) as {
      ordinal: number;
      path: string;
      name: string;
      size: number;
      kind: string;
    }[];
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

  remove(chatId: string): void {
    db().prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId);
    db().prepare('DELETE FROM message_attachments WHERE chat_id = ?').run(chatId);
  }

  private read(chatId: string, column: ChatColumn): string | undefined {
    const row = db()
      .prepare(`SELECT ${column} AS value FROM chats WHERE chat_id = ?`)
      .get(chatId) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  private write(chatId: string, column: ChatColumn, value: string): void {
    db()
      .prepare(
        `INSERT INTO chats (chat_id, ${column}) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET ${column} = excluded.${column}`,
      )
      .run(chatId, value);
  }
}
