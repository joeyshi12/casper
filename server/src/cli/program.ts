import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { configFilePath, dataDirPath } from '../paths.js';
import { generateToken, printTokenBlock, readSettings, updateSettings } from './settings.js';

// config.ts is loaded lazily inside the actions that need it: it snapshots settings
// at import, so bootstrap must write a first-run token first.

declare const __CASPER_VERSION__: string;
const VERSION = typeof __CASPER_VERSION__ === 'string' ? __CASPER_VERSION__ : 'dev';

/** First run has no installer to lean on, so the shell installer's work happens
 *  here once, only when actually missing. */
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
    process.stdout.write(
      `keeping your edited agent file at ${agent.target}\n` +
        '  Prompt and tool updates are being skipped. Delete it to take them.\n',
    );
  }
}

function printToken(): void {
  const file = configFilePath();
  const token = readSettings(file).token;
  if (typeof token !== 'string' || token === '') {
    process.stderr.write(
      `casper: no token in ${file} - authentication is disabled.\n` +
        '  One is generated the first time you run `casper`.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${token}\n`);
}

/** Clears device logins too, or signed-in browsers keep working and "reset" means nothing. */
async function resetToken(value: string | undefined): Promise<void> {
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

  // The token is only read at startup; a running server needs a restart to pick it up.
  const { serviceActive } = await import('./service.js');
  if (serviceActive()) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('systemctl', ['--user', 'restart', 'casper.service'], { stdio: 'ignore' });
    process.stdout.write('restarted the service\n');
  } else {
    process.stdout.write('restart Casper for the new token to take effect\n');
  }
  printTokenBlock(token, 'New access token:');
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('casper')
    .description('Web client for kiro-cli over the Agent Client Protocol')
    .version(VERSION, '-v, --version')
    .showHelpAfterError()
    // Rejects unrecognised flags rather than treating them as positional; otherwise
    // `casper reset-token --dry-run` adopted "--dry-run" as the new token.
    .addHelpText('after', `\nSettings live in ${configFilePath()}.\nUpdate with: npm install -g @joeyshi12/casper`);

  program
    .command('start')
    .description('run the server in the foreground')
    .action(async () => {
      await bootstrap();
      const { serve } = await import('../server.js');
      await serve();
    });

  program
    .command('token')
    .description('print the access token')
    .action(printToken);

  program
    .command('reset-token')
    .argument('[value]', 'token to set; generated when omitted')
    .description('set a new token and sign every device out')
    .action(async (value: string | undefined) => {
      await resetToken(value);
    });

  program
    .command('doctor')
    .description('check kiro-cli, settings, data directory and web app')
    .action(async () => {
      process.exitCode = (await import('./doctor.js')).doctor();
    });

  program
    .command('mcp')
    .description('run the generative-UI MCP server on stdio (kiro spawns this itself)')
    .action(async () => {
      (await import('../mcp/server.js')).runMcpServer();
    });

  const service = program
    .command('service')
    .description('manage the systemd user service');

  const svcCommand = (name: string, describe: string, run: (m: typeof import('./service.js')) => number) =>
    service
      .command(name)
      .description(describe)
      .action(async () => {
        process.exitCode = run(await import('./service.js'));
      });

  svcCommand('install', 'run Casper as a systemd user service', (m) => m.serviceInstall());
  svcCommand('uninstall', 'remove the service (settings and sessions kept)', (m) => m.serviceUninstall());
  svcCommand('status', 'show the service status', (m) => m.serviceStatus());

  return program;
}
