import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFilePath, dataDirPath } from '../paths.js';
import { generateToken, printTokenBlock, readSettings, updateSettings } from './settings.js';

// config.ts, and anything that imports it, is loaded lazily inside the commands that
// need it. It snapshots its settings at import, so bootstrap has to write a
// first-run token before that happens - and loading the app would also open the
// database, which `casper token` has no business doing.

// Replaced by the bundler with package.json's version; 'dev' when run from source.
declare const __CASPER_VERSION__: string;
const VERSION = typeof __CASPER_VERSION__ === 'string' ? __CASPER_VERSION__ : 'dev';

const USAGE = `casper - web client for kiro-cli

Usage:
  casper                      run the server in the foreground
  casper token                print the access token
  casper reset-token [value]  set a new token and sign every device out
  casper doctor               check kiro-cli, settings, data dir and web app
  casper service install      run Casper as a systemd user service
  casper service uninstall    remove the service
  casper service status       show the service status

Settings live in ${configFilePath()}.
Update with: npm install -g @joeyshi12/casper
`;

/**
 * First run has no installer to lean on: npm has no hook we'd want to use, since
 * postinstall scripts are widely disabled and shouldn't be writing to a user's home
 * anyway. So the things the shell installer did happen here instead, once, and only
 * when they're actually missing.
 */
async function bootstrap(): Promise<void> {
  const file = configFilePath();
  const settings = readSettings(file);
  if (typeof settings.token !== 'string' || settings.token === '') {
    const token = generateToken();
    updateSettings(file, { token });
    printTokenBlock(token, 'Your Casper access token (paste it at the login screen):');
    process.stdout.write(`Saved to ${file}. Print it again with: casper token\n\n`);
  }

  const { installAgentFile } = await import('./agentFile.js');
  const agent = installAgentFile(os.homedir(), dataDirPath());
  if (agent.action === 'installed' || agent.action === 'updated') {
    process.stdout.write(`casper agent ${agent.action}: ${agent.target}\n`);
  } else if (agent.action === 'kept-yours') {
    process.stdout.write(`keeping your edited agent file at ${agent.target}\n`);
  }
}

function printToken(): number {
  const file = configFilePath();
  const token = readSettings(file).token;
  if (typeof token !== 'string' || token === '') {
    process.stderr.write(
      `casper: no token in ${file} - authentication is disabled.\n` +
        '  One is generated the first time you run `casper`.\n',
    );
    return 1;
  }
  process.stdout.write(`${token}\n`);
  return 0;
}

/**
 * Rotating the token has to clear device logins too, or the browsers already signed
 * in keep working and "reset" means nothing. Sessions and titles are left alone.
 */
async function resetToken(value: string | undefined): Promise<number> {
  const token = value && value !== '' ? value : generateToken();
  const file = configFilePath();
  updateSettings(file, { token });
  process.stdout.write(`wrote a new token to ${file}\n`);

  const dbFile = path.join(dataDirPath(), 'casper.db');
  if (fs.existsSync(dbFile)) {
    const { LoginStore } = await import('../session/logins.js');
    new LoginStore().revokeAll();
    process.stdout.write('revoked all device sessions\n');
  }

  // The token is only read at startup, so a running server keeps accepting the old
  // one until it restarts.
  if ((await import('./service.js')).serviceActive()) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('systemctl', ['--user', 'restart', 'casper.service'], { stdio: 'ignore' });
    process.stdout.write('restarted the service\n');
  } else {
    process.stdout.write('restart Casper for the new token to take effect\n');
  }
  printTokenBlock(token, 'New access token:');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'start': {
      await bootstrap();
      // Imported here, not at the top: loading the app also opens the database,
      // because routes/auth.ts builds a LoginStore at module scope. `casper token`
      // and `casper doctor` have no business creating casper.db.
      const { serve } = await import('../server.js');
      await serve();
      return 0;
    }
    case 'token':
      return printToken();
    case 'reset-token':
      return resetToken(rest[0]);
    case 'doctor':
      return (await import('./doctor.js')).doctor();
    case 'service': {
      const svc = await import('./service.js');
      switch (rest[0]) {
        case 'install':
          return svc.serviceInstall();
        case 'uninstall':
          return svc.serviceUninstall();
        case 'status':
        case undefined:
          return svc.serviceStatus();
        default:
          process.stderr.write(`casper: unknown service command "${rest[0]}"\n`);
          return 2;
      }
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      process.stderr.write(`casper: unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
