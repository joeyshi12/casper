import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

/**
 * Casper's own persistence: one SQLite file holding the state kiro doesn't know
 * about.
 *
 * `sessions` carries the per-session overrides Casper layers on top of kiro's
 * files (a renamed title, a re-pointed working directory); `logins` carries the
 * device sessions the auth cookie is checked against. These used to be three
 * JSON files rewritten whole on every change, which meant a losable write and an
 * artificial split between titles and cwds even though both are keyed by session.
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

/** The open database, opening (and migrating) it on first use. */
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
  importLegacyJson(d);
  return d;
}

/**
 * Rename a migrated file aside without destroying an earlier backup.
 *
 * A pre-SQLite build left running alongside this one can recreate these files, so
 * the migration may fire more than once; plain renameSync would then overwrite the
 * first backup with the second file.
 */
function setAside(file: string): void {
  let target = `${file}.bak`;
  for (let n = 2; fs.existsSync(target); n++) target = `${file}.bak.${n}`;
  fs.renameSync(file, target);
}

/** Read a legacy JSON file, or null if it's absent or unparseable. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Fold the three pre-SQLite JSON files in, once.
 *
 * Each is renamed to .bak rather than deleted: if this misreads something, the
 * original is still there. Losing logins.json would sign every device out, so
 * it's worth being careful with.
 */
function importLegacyJson(d: DatabaseSync): void {
  const dir = config.casperDataDir;

  const pairs: [string, 'title' | 'cwd'][] = [
    [path.join(dir, 'titles.json'), 'title'],
    [path.join(dir, 'cwds.json'), 'cwd'],
  ];
  for (const [file, column] of pairs) {
    const doc = readJson(file);
    if (!doc || typeof doc !== 'object') continue;
    const rows = Object.entries(doc as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'string',
    );
    const stmt = d.prepare(
      `INSERT INTO sessions (session_id, ${column}) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET ${column} = excluded.${column}`,
    );
    for (const [sessionId, value] of rows) stmt.run(sessionId, value as string);
    setAside(file);
    logger.info({ file, rows: rows.length }, 'migrated legacy store into sqlite');
  }

  const loginFile = path.join(dir, 'logins.json');
  const logins = readJson(loginFile);
  if (Array.isArray(logins)) {
    const stmt = d.prepare(
      `INSERT INTO logins (id, hash, created_at, last_seen_at, user_agent)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    );
    let n = 0;
    for (const r of logins) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.hash !== 'string') continue;
      stmt.run(
        rec.id,
        rec.hash,
        typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
        typeof rec.lastSeenAt === 'string' ? rec.lastSeenAt : new Date().toISOString(),
        typeof rec.userAgent === 'string' ? rec.userAgent : null,
      );
      n++;
    }
    setAside(loginFile);
    logger.info({ file: loginFile, rows: n }, 'migrated legacy store into sqlite');
  }
}
