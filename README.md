<p align="center">
<img src="/assets/banner.svg" alt="Casper banner" width="100%"/>
</p>

<p align="center">
<a href="https://github.com/joeyshi12/casper/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT"/></a>
<a href="https://github.com/joeyshi12/casper/releases"><img src="https://img.shields.io/github/release/joeyshi12/casper.svg" alt="Version"/></a>
<a href="https://github.com/joeyshi12/casper/actions/workflows/test.yml"><img src="https://github.com/joeyshi12/casper/actions/workflows/test.yml/badge.svg" alt="Tests"/></a>
</p>

A web client for `kiro-cli`, over its Agent Client Protocol (ACP).
Start a long Kiro task and it keeps running server-side.
On reconnect the client replays exactly what it missed.

## Features

- **Sessions** - create, search, rename, switch, and delete. Live sessions run
  in a bounded process pool; idle ones go dormant and resume on demand.
- **Per-session model & agent** - from the live model list and kiro's agents.
- **Rich rendering** - Markdown, Mermaid diagrams, syntax-highlighted code, and
  MCP tool calls with status/input/output.
- **File browser** - browse the session's workspace, preview files
  (syntax-highlighted text, images, PDFs), and download them.
- **Observability** - credits spent, context-window usage, and turn duration.
- **PWA** - installable, responsive, auto-reconnects when the network returns.

## Prerequisites

- [`kiro-cli`](https://kiro.dev) installed and authenticated (`kiro-cli login`) -
  Casper is a client for it, so nothing works without it.
- Node.js 24+ (Casper stores its state in SQLite via the built-in `node:sqlite`).
- `git` and `npm`, if you use the one-line installer (it clones and builds from source).
- systemd is **optional** - it's only used to auto-start Casper as a background
  service that survives reboots. Without it (or under a different init system),
  you run Casper with the `casper` command.

## Develop

Requires Node 24+ and an authenticated `kiro-cli` on `PATH`.

```bash
npm install
CASPER_TOKEN=dev npm run dev   # server + web dev servers together
```

Open the printed URL and paste that token.

## Configuration

Casper is configured from `~/.config/casper/config.json` (or
`$XDG_CONFIG_HOME/casper/`), using camelCase keys. It lives outside the install
directory so it survives updates, and the installer writes it for you:

```json
{
  "port": 4319,
  "defaultCwd": "/home/you/projects",
  "fileRoot": "/home/you",
  "defaultAgent": "casper"
}
```

It holds the access token, so it's written `chmod 600`. A missing, malformed, or
wrongly-shaped file is ignored with a warning rather than failing startup, and
unrecognised keys are reported so a typo doesn't pass silently.

Every setting can also be given as an **environment variable, which takes
precedence** over the file - convenient for containers, one-off runs, and tests.
Three are environment-only and live in `.env` in the install directory:
`CASPER_DATA_DIR` (it says where data lives, so it can't be read from inside it),
`CASPER_WEB_DIST` (install layout), and `CASPER_NODE` (the binary the `casper`
runner execs). Setting anything else in both places is just a way to confuse
yourself, since the environment silently wins.

### Reference


Environment variable, matching config key, and default:

| Var | Config key | Default | Purpose |
|-----|------------|---------|---------|
| `HOST` | `host` | `0.0.0.0` | Bind address |
| `PORT` | `port` | `4319` | Server port |
| `CASPER_TOKEN` | `token` | _(empty)_ | Shared secret entered once at login; server exchanges it for a per-device session cookie. **Set before exposing.** Run `casper token` to print the current value. |
| `CASPER_SESSION_TTL_SECONDS` | `sessionTtlSeconds` | `604800` | Device-login lifetime (slid forward on activity). |
| `KIRO_BIN` | `kiroBin` | `kiro-cli` | Path to the kiro-cli binary |
| `DEFAULT_CWD` | `defaultCwd` | cwd | Default working directory for new sessions |
| `CASPER_FILE_ROOT` | `fileRoot` | `/` | Filesystem root that file-serving endpoints are confined to; requests resolving outside it are rejected. Defaults to `/` (the whole filesystem the server can read); set a narrower path (e.g. `$HOME`) to restrict file browsing. |
| `MAX_LIVE_SESSIONS` | `maxLiveSessions` | `6` | Max concurrent live kiro processes |
| `DEFAULT_AGENT` | `defaultAgent` | `kiro_default` | Default agent for new sessions |
| `CASPER_WEB_DIST` | _(env only)_ | `../web/dist` | Built web app to serve (set to an absolute path in prod) |
| `CASPER_NODE` | _(env only)_ | `node` | Explicit Node binary for the `casper` runner (the installer records the resolved path so the service starts under a minimal PATH). |

## Install

Make sure `kiro-cli` is installed and logged in (`kiro-cli login`), then run:

```bash
curl -fsSL https://raw.githubusercontent.com/joeyshi12/casper/refs/heads/main/scripts/install.sh | bash
```

This builds Casper and puts a `casper` command on your `PATH`. Where user
systemd is available it also starts Casper as a background service that
survives reboots - it's already running, so open the URL the installer
printed. Without systemd, start it yourself:

```bash
casper           # runs in the foreground (Ctrl-C to stop)
```

Background it however your setup prefers: your init system, `nohup casper &`,
or tmux.

Your access token prints once in a bordered block - copy it before scrolling.
If you lose it, run `casper token`, or read `token` from
`~/.config/casper/config.json`.

**Update:** `casper update` pulls the latest version, rebuilds, and restarts
the service if one is running. Your token is preserved.

**Uninstall:** `~/.local/share/casper/scripts/uninstall.sh` (add `--purge` to
also delete saved sessions, logins, and your settings).

**HTTPS** (recommended beyond your LAN): put a TLS-terminating reverse proxy
in front, pointed at `http://127.0.0.1:4319`, forwarding WebSocket upgrades
with a long read timeout for lengthy agent turns. Required for PWA install
and reliable reconnects.

## Verify

```bash
npm test        # unit tests (node:test)
npm run e2e     # full server: prompt, disconnect mid-turn, reconnect, replay
```

## Security

Casper launches kiro with `--trust-all-tools` so unattended runs never block on
approvals - the agent can run commands and write files without confirmation.
Always set `CASPER_TOKEN` and put the server behind HTTPS before exposing it.
