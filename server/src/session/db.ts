import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * Casper's own persistence: one SQLite file for the state kiro doesn't keep. `chats`
 * is the chat itself, with any title, cwd or pin the user set; `logins` holds device
 * sessions; `message_attachments` records what was attached to each prompt;
 * `turn_endings` holds turns that failed or were stopped; `kiro_models` keeps the name
 * and effort levels kiro last reported for each model, so the picker has them before any
 * session has started. node:sqlite is built in, which is why the Node floor is 24.
 *
 * Attachments are keyed by ordinal (the user message's position), the only identity
 * a live message (event seq) and a rebuilt one (kiro's message_id) can agree on.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id    TEXT PRIMARY KEY,
  session_id TEXT UNIQUE,
  title      TEXT,
  cwd        TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS logins (
  id           TEXT PRIMARY KEY,
  hash         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS logins_hash ON logins (hash);
CREATE TABLE IF NOT EXISTS message_attachments (
  chat_id  TEXT    NOT NULL,
  ordinal  INTEGER NOT NULL,
  path     TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  size     INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  PRIMARY KEY (chat_id, ordinal, path)
);
CREATE TABLE IF NOT EXISTS turn_endings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL,
  prompt     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  message    TEXT,
  items      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_endings_chat ON turn_endings (chat_id);
CREATE TABLE IF NOT EXISTS kiro_models (
  model_id    TEXT PRIMARY KEY,
  name        TEXT,
  levels      TEXT NOT NULL,
  recommended TEXT,
  effort_key  TEXT
);
`;

let handle: DatabaseSync | undefined;

export function db(): DatabaseSync {
  if (!handle) handle = open();
  return handle;
}

/** For tests that need to repoint casperDataDir. */
export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

function open(): DatabaseSync {
  fs.mkdirSync(config.casperDataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.casperDataDir, 'casper.db');
  const d = new DatabaseSync(file);
  // WAL so a reader never blocks the writer. Writers still take an exclusive lock,
  // so each test file points casperDataDir elsewhere.
  d.exec('PRAGMA journal_mode = WAL');
  d.exec(SCHEMA);
  // A database made before these columns existed.
  const columns = (table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!columns('kiro_models').includes('effort_key')) d.exec('ALTER TABLE kiro_models ADD COLUMN effort_key TEXT');
  if (!columns('chats').includes('pinned')) d.exec('ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  // Set explicitly on every open: the logins table holds auth hashes, and this
  // also repairs a database created before the restriction existed.
  restrict(config.casperDataDir, 0o700);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) restrict(f, 0o600);
  return d;
}

function restrict(target: string, mode: number): void {
  try {
    if ((fs.statSync(target).mode & 0o777) !== mode) fs.chmodSync(target, mode);
  } catch {
    // absent or not ours to change
  }
}
