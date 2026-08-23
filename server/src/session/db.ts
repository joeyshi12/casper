import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * Casper's own persistence: one SQLite file for the state kiro doesn't keep.
 *
 * `sessions` holds the per-session overrides layered on kiro's files (renamed title,
 * re-pointed working directory); `logins` holds the device sessions the auth cookie is
 * checked against; `message_attachments` records what was attached to each prompt.
 * node:sqlite is built in, which is why the Node floor is 24 rather than a native driver.
 *
 * Attachments are keyed by ordinal - the position of the user message within the session -
 * because that is the only identity both halves of the app can compute. A live message is
 * identified by Casper's event seq and a rebuilt one by kiro's message_id, and neither is
 * available to the other; Casper doesn't persist its own transcript, so history is
 * reconstructed from kiro's file, where position is all there is.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title      TEXT,
  cwd        TEXT,
  -- The chat this session belongs to, which owns its uploads directory. Minted by the
  -- client before the session exists, so a new chat can attach a file before it sends.
  -- NULL for a session Casper did not create, such as one started with kiro-cli directly;
  -- getChatId names those after the session.
  chat_id    TEXT
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
  session_id TEXT    NOT NULL,
  ordinal    INTEGER NOT NULL,
  path       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  PRIMARY KEY (session_id, ordinal, path)
);
`;

let handle: DatabaseSync | undefined;

/** The open database, opening it on first use. */
export function db(): DatabaseSync {
  if (!handle) handle = open();
  return handle;
}

/** Close the handle. For tests that need to repoint casperDataDir. */
export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

function open(): DatabaseSync {
  fs.mkdirSync(config.casperDataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.casperDataDir, 'casper.db');
  const d = new DatabaseSync(file);
  // WAL so a reader never blocks the writer, and it survives an unclean shutdown
  // better than a rewritten JSON file did. Writers still take an exclusive lock, so
  // two processes on one file contend - which is why each test file points
  // casperDataDir at its own directory rather than sharing this one.
  d.exec('PRAGMA journal_mode = WAL');
  d.exec(SCHEMA);
  // The logins table holds the hashes the auth cookie is checked against, so the
  // file has no business being world-readable. sqlite creates it with the process
  // umask, and mkdir's mode doesn't apply to an existing directory, so both are set
  // explicitly and on every open - that also repairs a database created earlier.
  restrict(config.casperDataDir, 0o700);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) restrict(f, 0o600);
  return d;
}

/** Narrow a path's mode, ignoring a missing file or a filesystem that refuses. */
function restrict(target: string, mode: number): void {
  try {
    if ((fs.statSync(target).mode & 0o777) !== mode) fs.chmodSync(target, mode);
  } catch {
    // absent (the -wal only appears once written to) or not ours to change
  }
}
