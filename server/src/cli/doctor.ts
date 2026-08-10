import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { readSettings } from './settings.js';

/**
 * The checks the shell installer ran as preflight, kept after it was deleted.
 *
 * These are the things that make Casper look broken for reasons outside itself -
 * kiro missing or not logged in, no token, an unreadable data directory - so it's
 * worth being able to ask.
 */
type Check = { ok: boolean; name: string; detail: string; fatal?: boolean };

// Walk PATH rather than shelling out to `command -v`: kiroBin is user-supplied, and
// handing it to a shell would both invite injection and trip node's deprecation
// warning for shell + args.
function which(bin: string): string | undefined {
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : undefined;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return undefined;
}

function checks(): Check[] {
  const out: Check[] = [];

  out.push({
    ok: true,
    name: 'node',
    detail: `${process.version} at ${process.execPath}`,
  });

  const kiro = which(config.kiroBin);
  if (kiro) {
    let version = '';
    try {
      version = execFileSync(config.kiroBin, ['--version'], { encoding: 'utf8' }).trim();
    } catch {
      version = '(version unavailable)';
    }
    out.push({ ok: true, name: 'kiro-cli', detail: `${version} at ${kiro}` });
  } else {
    out.push({
      ok: false,
      fatal: true,
      name: 'kiro-cli',
      detail: `not found on PATH (looked for "${config.kiroBin}"). Casper is a client for it, so nothing works without it.`,
    });
  }

  const settings = readSettings(config.configFile);
  const hasToken = typeof settings.token === 'string' && settings.token !== '';
  out.push(
    fs.existsSync(config.configFile)
      ? {
          ok: hasToken,
          name: 'settings',
          detail: hasToken
            ? `${config.configFile} (token set)`
            : `${config.configFile} exists but has no token - auth is DISABLED`,
        }
      : {
          ok: false,
          name: 'settings',
          detail: `${config.configFile} not found; a token is generated on first run`,
        },
  );

  if (fs.existsSync(config.configFile)) {
    const mode = fs.statSync(config.configFile).mode & 0o777;
    out.push({
      ok: mode === 0o600,
      name: 'settings mode',
      detail:
        mode === 0o600
          ? '0600'
          : `${mode.toString(8).padStart(3, '0')} - it holds the token; chmod 600 it`,
    });
  }

  try {
    fs.mkdirSync(config.casperDataDir, { recursive: true });
    fs.accessSync(config.casperDataDir, fs.constants.W_OK);
    const db = path.join(config.casperDataDir, 'casper.db');
    const size = fs.existsSync(db) ? `, casper.db ${(fs.statSync(db).size / 1024).toFixed(0)} KB` : '';
    out.push({ ok: true, name: 'data dir', detail: `${config.casperDataDir} writable${size}` });
  } catch (err) {
    out.push({
      ok: false,
      fatal: true,
      name: 'data dir',
      detail: `${config.casperDataDir} is not writable: ${(err as Error).message}`,
    });
  }

  out.push(
    fs.existsSync(config.webDist)
      ? { ok: true, name: 'web app', detail: config.webDist }
      : {
          ok: false,
          fatal: true,
          name: 'web app',
          detail: `${config.webDist} not found - the package is incomplete or CASPER_WEB_DIST is wrong`,
        },
  );

  const agent = path.join(config.kiroSessionsDir, '..', '..', 'agents', 'casper.json');
  out.push({
    ok: fs.existsSync(agent),
    name: 'casper agent',
    detail: fs.existsSync(agent) ? agent : `${agent} missing - it is installed on first run`,
  });

  return out;
}

export function doctor(): number {
  const results = checks();
  for (const c of results) {
    const mark = c.ok ? '\u001b[32m✓\u001b[0m' : c.fatal ? '\u001b[31m✗\u001b[0m' : '\u001b[33m!\u001b[0m';
    process.stdout.write(`${mark} ${c.name.padEnd(14)} ${c.detail}\n`);
  }
  const fatal = results.filter((c) => !c.ok && c.fatal);
  if (fatal.length > 0) {
    process.stdout.write(`\n${fatal.length} problem(s) will stop Casper from working.\n`);
    return 1;
  }
  return 0;
}
