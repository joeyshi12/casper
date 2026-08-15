import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

/**
 * Install Casper as a systemd user service.
 *
 * The unit hardcodes the resolved node binary and script path. Both move when node
 * is upgraded or the package is reinstalled, so `casper service install` has to be
 * re-run after either - that's the accepted trade for a unit that starts reliably
 * under systemd's minimal PATH, where a bare `node` often isn't found.
 *
 * systemd is optional: without it you run `casper` yourself.
 */
const SERVICE = 'casper.service';

function unitPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user', SERVICE);
}

function systemctl(args: string[], quiet = false): number {
  const r = spawnSync('systemctl', ['--user', ...args], {
    stdio: quiet ? 'ignore' : 'inherit',
  });
  return r.status ?? 1;
}

function hasUserSystemd(): boolean {
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  return r.status === 0;
}

/** The entry the bin symlink points at, which is what the unit must exec. */
function entryScript(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const bundled = path.join(here, 'casper.js');
  if (fs.existsSync(bundled)) return bundled;
  return path.resolve(here, '../index.js');
}

export function serviceInstall(): number {
  if (!hasUserSystemd()) {
    process.stderr.write(
      'casper: no user systemd here. Run Casper with `casper`, or start it from your own init system.\n',
    );
    return 1;
  }

  const unit = unitPath();
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(
    unit,
    `[Unit]
Description=Casper (kiro-cli web client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${os.homedir()}
Environment=NODE_ENV=production
ExecStart=${process.execPath} ${entryScript()}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`,
  );
  process.stdout.write(`wrote ${unit}\n`);

  // Without linger the service stops when the last session for this user ends.
  try {
    execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' });
  } catch {
    process.stderr.write(
      `! could not enable linger; the service may stop at logout. Run: sudo loginctl enable-linger ${os.userInfo().username}\n`,
    );
  }

  systemctl(['daemon-reload']);
  if (systemctl(['enable', '--now', SERVICE]) !== 0) {
    process.stderr.write(`! could not start the service. Check: systemctl --user status ${SERVICE}\n`);
    return 1;
  }
  process.stdout.write('casper is running as a systemd user service\n');
  return 0;
}

export function serviceUninstall(): number {
  if (!hasUserSystemd()) {
    process.stderr.write('casper: no user systemd here; nothing to remove.\n');
    return 1;
  }
  systemctl(['disable', '--now', SERVICE], true);
  const unit = unitPath();
  if (fs.existsSync(unit)) {
    fs.rmSync(unit);
    process.stdout.write(`removed ${unit}\n`);
  }
  systemctl(['daemon-reload'], true);
  process.stdout.write('service removed; your sessions and settings are untouched\n');
  return 0;
}

export function serviceStatus(): number {
  if (!hasUserSystemd()) {
    process.stdout.write('no user systemd here; Casper is not running as a service\n');
    return 0;
  }
  return systemctl(['status', '--no-pager', SERVICE]);
}

export function serviceActive(): boolean {
  return spawnSync('systemctl', ['--user', 'is-active', '--quiet', SERVICE], { stdio: 'ignore' })
    .status === 0;
}
