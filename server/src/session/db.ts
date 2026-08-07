import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * Casper's own persistence: one SQLite file holding the state kiro doesn't know
 * about.
 *
 * `sessions` carries the per-session overrides Casper layers on top of kiro's
 * files (a renamed title, a re-pointed working directory); `logins` carries the
 * device sessions the auth cookie is checked against.
 *
 * node:sqlite is built in, so this costs no dependency - which is why the Node
 * floor is 24 rather than shipping a native driver.
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
  fs.mkdirSync(config.casperDataDir, { recursive: true });
  const d = new DatabaseSync(path.join(config.casperDataDir, 'casper.db'));
  // WAL so a reader never blocks the writer; both are this one process, but it
  // also survives an unclean shutdown better than a rewritten JSON file did.
  d.exec('PRAGMA journal_mode = WAL');
  d.exec(SCHEMA);
  return d;
}
