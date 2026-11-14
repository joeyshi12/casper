import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { configFilePath, dataDirPath } from './paths.js';
import { logger } from './util/logger.js';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const home = os.homedir();

/** Where the built web app lives, resolved against this module since a global
 *  install runs from wherever the user happens to be. */
function defaultWebDist(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const bundled = path.join(here, 'web');
  const workspace = path.resolve(here, '../../web/dist');
  return fs.existsSync(bundled) ? bundled : workspace;
}

/** Recognised keys, so a typo is reported rather than silently ignored. */
const KNOWN_KEYS = new Set([
  'host',
  'port',
  'token',
  'kiroBin',
  'kiroSessionsDir',
  'defaultCwd',
  'maxLiveSessions',
  'defaultAgent',
  'fileRoot',
  'maxUploadBytes',
]);

/** Parses config-file text into settings, reporting rather than throwing: a broken
 *  file must never stop the server starting. */
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
  const file = configFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      logger.warn({ file, err }, 'config: unreadable, falling back to defaults');
    }
    return {};
  }

  const obj = parseConfigDoc(raw, (msg, detail) => logger.warn({ file, detail }, msg));
  // A token in a world-readable file is a shared secret worth flagging.
  if (typeof obj.token === 'string' && obj.token !== '') {
    try {
      const mode = fs.statSync(file).mode & 0o077;
      if (mode !== 0) {
        logger.warn({ file }, 'config: holds a token but is readable by others; chmod 600 it');
      }
    } catch {
      /* not worth failing startup over */
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

// The environment can set only the few settings that differ per launch: where to listen,
// the token, and the kiro-cli binary. Everything else comes from the config file.
const envSetting = (envName: string, key: string, fallback: string): string =>
  pickString(process.env[envName], fileConfig[key], fallback);

const envSettingInt = (envName: string, key: string, fallback: number): number =>
  pickInt(process.env[envName], fileConfig[key], fallback);

const setting = (key: string, fallback: string): string => pickString(undefined, fileConfig[key], fallback);

const settingInt = (key: string, fallback: number): number => pickInt(undefined, fileConfig[key], fallback);

/** Environment variables earlier versions read, and what replaced each. */
const RETIRED_ENV: Record<string, string> = {
  HOST: 'CASPER_HOST',
  PORT: 'CASPER_PORT',
  KIRO_BIN: 'CASPER_KIRO_BIN',
  DEFAULT_CWD: 'defaultCwd in the config file',
  DEFAULT_AGENT: 'defaultAgent in the config file',
  CASPER_FILE_ROOT: 'fileRoot in the config file',
  CASPER_KIRO_SESSIONS_DIR: 'kiroSessionsDir in the config file',
  MAX_LIVE_SESSIONS: 'maxLiveSessions in the config file',
  CASPER_MAX_UPLOAD_BYTES: 'maxUploadBytes in the config file',
  CASPER_SESSION_TTL_SECONDS: 'nothing; the login lifetime is fixed at 7 days',
  EVENT_BUFFER_SIZE: 'nothing; the replay buffer is fixed',
};

/** A warning for each retired variable that is set, so an old override is not lost silently. */
export function retiredEnvWarnings(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(RETIRED_ENV)
    .filter(([name]) => env[name] !== undefined && env[name] !== '')
    .map(([name, now]) => `${name} is no longer read; use ${now}`);
}

for (const msg of retiredEnvWarnings(process.env)) logger.warn(`config: ${msg}`);

// Resolves kiro-cli to an absolute path: a minimal systemd/bare-node PATH may
// omit ~/.toolbox/bin, so `spawn kiro-cli` would otherwise ENOENT.
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
  host: envSetting('CASPER_HOST', 'host', '0.0.0.0'),
  port: envSettingInt('CASPER_PORT', 'port', 4319),
  /** Shared secret for login. Empty disables auth (dev only). */
  token: envSetting('CASPER_TOKEN', 'token', ''),
  kiroBin: resolveKiroBin(envSetting('CASPER_KIRO_BIN', 'kiroBin', 'kiro-cli'), home),
  defaultCwd: setting('defaultCwd', process.cwd()),
  maxLiveSessions: settingInt('maxLiveSessions', 6),
  /** The agent Casper installs, with the widget tools. kiro falls back to its Default
   *  mode if it is missing rather than failing. */
  defaultAgent: setting('defaultAgent', 'casper'),
  /** Filesystem root the file endpoints are confined to. Defaults to /; narrow it
   *  to keep authenticated users out of system files such as /etc or SSH keys. */
  fileRoot: path.resolve(setting('fileRoot', '/')),
  /** kiro's session store, one directory per workspace. */
  kiroSessionsDir: path.resolve(setting('kiroSessionsDir', path.join(home, '.kiro', 'sessions'))),
  casperDataDir: dataDirPath(),
  webDist: env('CASPER_WEB_DIST', defaultWebDist()),
  maxUploadBytes: settingInt('maxUploadBytes', 100 * 1024 * 1024),
  configFile: configFilePath(),
} as const;

