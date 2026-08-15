import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * Casper's own persistence: one SQLite file for the state kiro doesn't keep.
 *
 * `sessions` holds the per-session overrides layered on kiro's files (renamed title,
 * re-pointed working directory); `logins` holds the device sessions the auth cookie is
 * checked against. node:sqlite is built in, which is why the Node floor is 24 rather
 * than a native driver.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
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
  // WAL so a reader never blocks the writer; both are this one process, but it
  // also survives an unclean shutdown better than a rewritten JSON file did.
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
