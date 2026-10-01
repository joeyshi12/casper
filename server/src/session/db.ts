import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * Casper's own persistence: one SQLite file for the state kiro doesn't keep. `chats`
 * is the chat itself; `logins` holds device sessions; `message_attachments` records
 * what was attached to each prompt; `subagent_links` records which parent tool call
 * and stage name a child session belongs to. node:sqlite is built in, which is why
 * the Node floor is 24.
 *
 * Attachments are keyed by ordinal (the user message's position), the only identity
 * a live message (event seq) and a rebuilt one (kiro's message_id) can agree on.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id    TEXT PRIMARY KEY,
  session_id TEXT UNIQUE,
  title      TEXT,
  cwd        TEXT
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
CREATE TABLE IF NOT EXISTS subagent_links (
  child_session_id  TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  tool_call_id      TEXT NOT NULL,
  stage_name        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subagent_links_parent ON subagent_links (parent_session_id);
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
