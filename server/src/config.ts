import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// Resolve kiro-cli to an absolute path. A server started outside an interactive
// shell (systemd, bare node) may have a minimal PATH that omits ~/.toolbox/bin,
// causing `spawn kiro-cli` to fail with ENOENT. Try an explicit path, then the
// login shell's PATH, then common install locations.
function resolveKiroBin(explicit: string, home: string): string {
  if (explicit.includes('/') && fs.existsSync(explicit)) return explicit;

  try {
    const found = execFileSync('/bin/sh', ['-lc', `command -v ${explicit}`], {
      encoding: 'utf8',
    }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    // not on PATH, keep looking
  }

  const candidates = [
    path.join(home, '.toolbox', 'bin', explicit),
    path.join(home, '.local', 'bin', explicit),
    path.join('/usr', 'local', 'bin', explicit),
    path.join('/opt', 'homebrew', 'bin', explicit),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return explicit;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const home = os.homedir();

export const config = {
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 4319),
  /** Shared-secret token required to log in. Empty string disables auth (dev only). */
  token: env('CASPER_TOKEN', ''),
  /** Device-login lifetime in seconds; slid forward on activity. Default 7 days. */
  sessionTtlSeconds: envInt('CASPER_SESSION_TTL_SECONDS', 60 * 60 * 24 * 7),
  kiroBin: resolveKiroBin(env('KIRO_BIN', 'kiro-cli'), home),
  // Working directory for new sessions when the user doesn't pick one. Defaults
  // to the user's home directory - not the server's own install dir, which is
  // where the process happens to run from under systemd / the casper runner.
  // Set DEFAULT_CWD to override.
  defaultCwd: env('DEFAULT_CWD', home),
  maxLiveSessions: envInt('MAX_LIVE_SESSIONS', 6),
  defaultAgent: env('DEFAULT_AGENT', 'kiro_default'),
  /**
   * Filesystem root that file-serving endpoints (/api/fs/dirs, /api/fs/image)
   * are confined to. Requests resolving outside this root are rejected.
   * Defaults to the filesystem root (/), so file browsing spans everything the
   * server process can read. Set CASPER_FILE_ROOT to a narrower path (e.g. the
   * user's home directory) to stop authenticated users from reading system
   * files such as /etc or SSH keys.
   */
  fileRoot: path.resolve(env('CASPER_FILE_ROOT', '/')),
  /** Directory where kiro-cli persists its own session files. */
  kiroSessionsDir: path.join(home, '.kiro', 'sessions', 'cli'),
  /** Casper's own event-buffer mirror directory. */
  casperDataDir: env('CASPER_DATA_DIR', path.join(home, '.casper')),
  /** Directory to serve the built web app from (prod). */
  webDist: env('CASPER_WEB_DIST', path.resolve(process.cwd(), '../web/dist')),
  /** Per-session in-memory event ring buffer size. */
  eventBufferSize: envInt('EVENT_BUFFER_SIZE', 5000),
  /** Max size (bytes) for a single uploaded file. Default 100 MB. */
  maxUploadBytes: envInt('CASPER_MAX_UPLOAD_BYTES', 100 * 1024 * 1024),
} as const;

export type Config = typeof config;
