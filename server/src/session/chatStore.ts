import type { MessageAttachment, StoredTurnEnding, TranscriptItem, TurnEnding } from '@casper/shared';
import { db } from './db.js';

type ChatColumn = 'title' | 'cwd' | 'session_id';

export interface ChatRow {
  chatId: string;
  sessionId: string | null;
  title: string | null;
  cwd: string | null;
  pinned: boolean;
}

const COLUMNS = 'chat_id, session_id, title, cwd, pinned';

interface RawRow {
  chat_id: string;
  session_id: string | null;
  title: string | null;
  cwd: string | null;
  pinned: number;
}

const rowOf = (r: RawRow): ChatRow => ({
  chatId: r.chat_id,
  sessionId: r.session_id,
  title: r.title,
  cwd: r.cwd,
  pinned: r.pinned === 1,
});

/**
 * A chat is a conversation Casper started. The row is Casper's own: kiro's session file
 * holds the transcript, and this holds the chat's identity plus the title and cwd Casper
 * layers over it. Anything in kiro's sessions directory without a row here isn't a chat.
 */
export class ChatStore {
  all(): ChatRow[] {
    return (db().prepare(`SELECT ${COLUMNS} FROM chats`).all() as unknown as RawRow[]).map(rowOf);
  }

  get(chatId: string): ChatRow | undefined {
    const r = db().prepare(`SELECT ${COLUMNS} FROM chats WHERE chat_id = ?`).get(chatId) as unknown as RawRow | undefined;
    return r ? rowOf(r) : undefined;
  }

  create(chatId: string): void {
    db()
      .prepare('INSERT INTO chats (chat_id) VALUES (?) ON CONFLICT(chat_id) DO NOTHING')
      .run(chatId);
  }

  /** Binds the session kiro named once it started one. A session belongs to
   *  exactly one chat, so any earlier claim on it is released. */
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

  /** Returns false when there is no such chat. */
  setPinned(chatId: string, pinned: boolean): boolean {
    const r = db().prepare('UPDATE chats SET pinned = ? WHERE chat_id = ?').run(pinned ? 1 : 0, chatId);
    return Number(r.changes) > 0;
  }

  /** What was attached to one prompt, keyed by ordinal (see db.ts). */
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

  addTurnEnding(chatId: string, e: TurnEnding): void {
    db()
      .prepare(
        `INSERT INTO turn_endings (chat_id, started_at, ended_at, prompt, kind, message, items)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, e.startedAt, e.endedAt, e.prompt, e.kind, e.message ?? null, JSON.stringify(e.items));
  }

  turnEndingsByChat(chatId: string): StoredTurnEnding[] {
    const rows = db()
      .prepare(
        `SELECT id, started_at, ended_at, prompt, kind, message, items FROM turn_endings
         WHERE chat_id = ? ORDER BY id`,
      )
      .all(chatId) as {
      id: number;
      started_at: number;
      ended_at: number;
      prompt: string;
      kind: string;
      message: string | null;
      items: string;
    }[];
    const out: StoredTurnEnding[] = [];
    for (const r of rows) {
      try {
        out.push({
          id: r.id,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          prompt: r.prompt,
          kind: r.kind === 'interrupted' ? 'interrupted' : 'failed',
          ...(r.message === null ? {} : { message: r.message }),
          items: JSON.parse(r.items) as TranscriptItem[],
        });
      } catch {
        /* an unreadable row is skipped */
      }
    }
    return out;
  }

  /**
   * Copies what a branch keeps of another chat: the attachments of the first `prompts`
   * prompts, and the turn endings that started before `before` (all of them if unset).
   * `movePath` gives an attachment's path in the branch.
   */
  copyHistory(
    from: string,
    to: string,
    keep: { prompts: number; before?: number },
    movePath: (p: string) => string,
  ): void {
    for (const [ordinal, files] of this.attachmentsByChat(from)) {
      if (ordinal < keep.prompts) {
        this.setAttachments(to, ordinal, files.map((f) => ({ ...f, path: movePath(f.path) })));
      }
    }
    for (const e of this.turnEndingsByChat(from)) {
      if (keep.before === undefined || e.startedAt < keep.before) this.addTurnEnding(to, e);
    }
  }

  /** Drops what a rewind removes: the attachments from prompt `prompts` on, and the turn
   *  endings that started at or after `from`. */
  dropHistory(chatId: string, drop: { prompts: number; from: number }): void {
    db().prepare('DELETE FROM message_attachments WHERE chat_id = ? AND ordinal >= ?').run(chatId, drop.prompts);
    db().prepare('DELETE FROM turn_endings WHERE chat_id = ? AND started_at >= ?').run(chatId, drop.from);
  }

  remove(chatId: string): void {
    db().prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId);
    db().prepare('DELETE FROM message_attachments WHERE chat_id = ?').run(chatId);
    db().prepare('DELETE FROM turn_endings WHERE chat_id = ?').run(chatId);
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
