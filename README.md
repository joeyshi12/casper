<p align="center">
  <img src="/assets/banner.svg" alt="Casper banner" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/joeyshi12/casper/actions/workflows/ci.yml">
    <img src="https://github.com/joeyshi12/casper/actions/workflows/ci.yml/badge.svg" alt="CI status" />
  </a>
  <a href="https://github.com/joeyshi12/casper/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT" />
  </a>
  <a href="https://github.com/joeyshi12/casper/blob/main/package.json">
    <img src="https://img.shields.io/github/package-json/v/joeyshi12/casper" alt="Version" />
  </a>
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
- **Observability** - credits spent, context-window usage, and turn duration.
- **PWA** - installable, responsive, auto-reconnects when the network returns.

## Layout

- `shared/` - `@casper/shared`: the TypeScript contract (ACP, WS, REST types).
- `server/` - Fastify HTTP + WebSocket gateway that owns the `kiro-cli acp`
  child processes and a per-session replay buffer.
- `web/` - React + Vite PWA.

## Develop

Requires Node 18.20+ and an authenticated `kiro-cli` on `PATH`.

```bash
npm install
cp .env.example .env         # set CASPER_TOKEN to a random secret
npm run dev                  # server + web dev servers together
```

Open the printed URL and paste your `CASPER_TOKEN`.

## Configuration (`.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `4319` | Server port |
| `CASPER_TOKEN` | _(empty)_ | Shared secret entered once at login; server exchanges it for a per-device session cookie. **Set before exposing.** |
| `CASPER_SESSION_TTL_SECONDS` | `604800` | Device-login lifetime (slid forward on activity). |
| `KIRO_BIN` | `kiro-cli` | Path to the kiro-cli binary |
| `DEFAULT_CWD` | cwd | Default working directory for new sessions |
| `MAX_LIVE_SESSIONS` | `6` | Max concurrent live kiro processes |
| `DEFAULT_AGENT` | `kiro_default` | Default agent for new sessions |
| `CASPER_WEB_DIST` | `../web/dist` | Built web app to serve (set to an absolute path in prod) |
| `CASPER_NODE` | `node` | Explicit Node binary for the `casper` runner (the installer records the resolved path so the service starts under a minimal PATH). |

## Install

On the Linux machine you want to run Casper on, make sure `kiro-cli` is installed
and logged in (`kiro-cli login`), then run:

```bash
curl -fsSL https://raw.githubusercontent.com/joeyshi12/casper/refs/heads/main/scripts/install.sh | bash
```

That's it. The installer builds Casper, starts it in the background (and keeps it
running across reboots), and prints the URL and access token to open in your
browser. Re-run the same command any time to update to the latest version. Your
access token is preserved.

**Uninstall:**

```bash
~/.local/share/casper/scripts/uninstall.sh
```

Add `--purge` to also delete your saved sessions and logins.

**HTTPS (recommended when exposing beyond your LAN).** Put a TLS-terminating
reverse proxy in front. It's required for PWA install and reliable reconnects.
Point it at `http://127.0.0.1:4319`, forwarding WebSocket upgrades and using a
long read timeout for lengthy agent turns.

## Verify

```bash
npm test        # unit: observability fold
npm run e2e     # full server: prompt, disconnect mid-turn, reconnect, replay
```

## Security

Casper launches kiro with `--trust-all-tools` so unattended runs never block on
approvals - the agent can run commands and write files without confirmation.
Always set `CASPER_TOKEN` and put the server behind HTTPS before exposing it.
