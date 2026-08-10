import os from 'node:os';
import path from 'node:path';

/**
 * The two paths that have to be known before settings are read.
 *
 * Separate from config.ts, and free of any dependency, because config.ts evaluates
 * its settings once at import. First-run bootstrap has to write a generated token
 * *before* that snapshot is taken - otherwise the server starts with no token and
 * silently disables authentication until it's restarted.
 */
function fromEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v;
}

/** $XDG_CONFIG_HOME/casper/config.json, else ~/.config/casper/config.json. */
export function configFilePath(): string {
  const base = fromEnv('XDG_CONFIG_HOME') ?? path.join(os.homedir(), '.config');
  return path.join(base, 'casper', 'config.json');
}

/** Where casper.db lives: $CASPER_DATA_DIR, else ~/.casper. */
export function dataDirPath(): string {
  return fromEnv('CASPER_DATA_DIR') ?? path.join(os.homedir(), '.casper');
}
