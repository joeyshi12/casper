import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './util/logger.js';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const home = os.homedir();

/**
 * User settings file: $XDG_CONFIG_HOME/casper/config.json, or ~/.config/casper.
 *
 * Config lives here rather than beside the install so it survives a package
 * upgrade and works when Casper isn't a git clone at all. It can't hold
 * CASPER_DATA_DIR (that says where data lives, and this file isn't in it) or
 * CASPER_WEB_DIST (install layout, not a preference), so those stay env-only.
 */
function configFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(home, '.config');
  return path.join(base, 'casper', 'config.json');
}

/** Recognised keys, so a typo is reported rather than silently ignored. */
const KNOWN_KEYS = new Set([
  'host',
  'port',
  'token',
  'sessionTtlSeconds',
  'kiroBin',
  'defaultCwd',
  'maxLiveSessions',
  'defaultAgent',
  'fileRoot',
  'eventBufferSize',
  'maxUploadBytes',
]);

/**
 * Parse config-file text into settings, reporting rather than throwing.
 *
 * A broken config file must never stop the server starting - the user would have
 * no way to fix it through the UI. Anything unusable yields no settings, so every
 * value falls back to its default.
 */
export function parseConfigDoc(raw: string, onWarn: (msg: string, detail?: unknown) => void = () => {}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onWarn('config: invalid JSON, ignoring the file entirely', err);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    onWarn('config: expected a JSON object, ignoring');
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) onWarn('config: ignoring unrecognised keys', unknown);
  return obj;
}

function loadConfigFile(): Record<string, unknown> {
  const file = configFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Absent is the normal case; anything else is worth saying out loud.
    if ((err as { code?: string }).code !== 'ENOENT') {
      logger.warn({ file, err }, 'config: unreadable, falling back to defaults');
    }
    return {};
  }

  const obj = parseConfigDoc(raw, (msg, detail) => logger.warn({ file, detail }, msg));
  // A token in a world-readable file is worth flagging; it is a shared secret.
  if (typeof obj.token === 'string' && obj.token !== '') {
    try {
      const mode = fs.statSync(file).mode & 0o077;
      if (mode !== 0) {
        logger.warn({ file }, 'config: holds a token but is readable by others; chmod 600 it');
      }
    } catch {
      /* stat failed; not worth failing startup over */
    }
  }
  return obj;
}

const fileConfig = loadConfigFile();

/** Env wins, then the config file, then the built-in default. */
export function pickString(
  fromEnv: string | undefined,
  fromFile: unknown,
  fallback: string,
): string {
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (typeof fromFile === 'string' && fromFile !== '') return fromFile;
  return fallback;
}

/** As pickString, but the file may legitimately hold a JSON number or a string. */
export function pickInt(
  fromEnv: string | undefined,
  fromFile: unknown,
  fallback: number,
): number {
  if (fromEnv !== undefined && fromEnv !== '') {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n)) return n;
  }
  if (typeof fromFile === 'number' && Number.isFinite(fromFile)) return fromFile;
  if (typeof fromFile === 'string') {
    const n = Number.parseInt(fromFile, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

const setting = (envName: string, key: string, fallback: string): string =>
  pickString(process.env[envName], fileConfig[key], fallback);

const settingInt = (envName: string, key: string, fallback: number): number =>
  pickInt(process.env[envName], fileConfig[key], fallback);

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

export const config = {
  host: setting('HOST', 'host', '0.0.0.0'),
  port: settingInt('PORT', 'port', 4319),
  /** Shared-secret token required to log in. Empty string disables auth (dev only). */
  token: setting('CASPER_TOKEN', 'token', ''),
  /** Device-login lifetime in seconds; slid forward on activity. Default 7 days. */
  sessionTtlSeconds: settingInt('CASPER_SESSION_TTL_SECONDS', 'sessionTtlSeconds', 60 * 60 * 24 * 7),
  kiroBin: resolveKiroBin(setting('KIRO_BIN', 'kiroBin', 'kiro-cli'), home),
  defaultCwd: setting('DEFAULT_CWD', 'defaultCwd', process.cwd()),
  maxLiveSessions: settingInt('MAX_LIVE_SESSIONS', 'maxLiveSessions', 6),
  defaultAgent: setting('DEFAULT_AGENT', 'defaultAgent', 'kiro_default'),
  /**
   * Filesystem root that file-serving endpoints (/api/fs/dirs, /api/fs/image)
   * are confined to. Requests resolving outside this root are rejected.
   * Defaults to the filesystem root (/), so file browsing spans everything the
   * server process can read. Set CASPER_FILE_ROOT to a narrower path (e.g. the
   * user's home directory) to stop authenticated users from reading system
   * files such as /etc or SSH keys.
   */
  fileRoot: path.resolve(setting('CASPER_FILE_ROOT', 'fileRoot', '/')),
  /** Directory where kiro-cli persists its own session files. */
  kiroSessionsDir: path.join(home, '.kiro', 'sessions', 'cli'),
  /** Where casper.db lives. Env-only: it says where data is, and the config
   *  file isn't there. */
  casperDataDir: env('CASPER_DATA_DIR', path.join(home, '.casper')),
  /** Built web app to serve. Env-only: install layout, not a user preference. */
  webDist: env('CASPER_WEB_DIST', path.resolve(process.cwd(), '../web/dist')),
  /** Per-session in-memory event ring buffer size. */
  eventBufferSize: settingInt('EVENT_BUFFER_SIZE', 'eventBufferSize', 5000),
  /** Max size (bytes) for a single uploaded file. Default 100 MB. */
  maxUploadBytes: settingInt('CASPER_MAX_UPLOAD_BYTES', 'maxUploadBytes', 100 * 1024 * 1024),
  /** Absolute path of the settings file, for diagnostics. */
  configFile: configFile(),
} as const;

