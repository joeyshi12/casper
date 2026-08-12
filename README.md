<p align="center">
<img src="https://raw.githubusercontent.com/joeyshi12/casper/main/assets/banner.svg" alt="Casper banner" width="100%"/>
</p>

<p align="center">
<a href="https://github.com/joeyshi12/casper/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT"/></a>
<a href="https://www.npmjs.com/package/@joeyshi12/casper"><img src="https://img.shields.io/npm/v/@joeyshi12/casper.svg" alt="npm"/></a>
<a href="https://github.com/joeyshi12/casper/actions/workflows/test.yml"><img src="https://github.com/joeyshi12/casper/actions/workflows/test.yml/badge.svg" alt="Tests"/></a>
<a href="https://github.com/joeyshi12/casper/actions/workflows/publish.yml"><img src="https://github.com/joeyshi12/casper/actions/workflows/publish.yml/badge.svg" alt="Publish"/></a>
</p>

A web client for `kiro-cli`, over its Agent Client Protocol (ACP). Start a long
Kiro task and it keeps running server-side; on reconnect the client replays
exactly what it missed.

## Features

- **Sessions** you can create, search, rename and delete. Live ones run in a
  bounded process pool; idle ones go dormant and resume on demand.
- **Per-session model and agent**, from the live model list and kiro's agents.
- **Rich rendering** of Markdown, Mermaid, syntax-highlighted code, and MCP tool
  calls with their status, input and output.
- **File browser** for the session's workspace, previewing text, images and PDFs.
  HTML renders as a live page, sandboxed, and either can go fullscreen.
- **Widgets**: the agent calls a `show_widget` tool over MCP and the result renders
  inline as a live page. Charts, simulations, animated diagrams. Sandboxed, and they
  can send a message back.
- **Observability** for credits spent, context-window usage and turn duration.
- **PWA** that installs to a home screen and reconnects when the network returns.

## Install

Needs Node 24+, since Casper keeps its state in SQLite via the built-in
`node:sqlite`. It also needs [`kiro-cli`](https://kiro.dev) installed and logged in.
Casper is a client for it, so nothing works without it.

```bash
npm install -g @joeyshi12/casper
casper
```

The first run generates an access token, prints it in a bordered block, and drops
the `casper` agent into `~/.kiro/agents`. Open the printed URL and paste the token.

To survive reboots, install the systemd user service:

```bash
casper service install
```

systemd is optional. Without it, run `casper` from your own init system, under
`nohup`, or in tmux.

| Command | |
|---|---|
| `casper` | Run the server in the foreground |
| `casper token` | Print the access token |
| `casper reset-token [value]` | Set a new token and sign every device out |
| `casper doctor` | Check kiro-cli, settings, data directory, web app and MCP server |
| `casper mcp` | Run the widget MCP server on stdio (kiro spawns this for you) |
| `casper service install` | Run as a systemd user service |
| `casper service uninstall` | Remove the service, keeping settings and sessions |
| `casper service status` | Show the service status |

The `casper` agent gets the widget tools automatically. To give them to another
agent, point it at the same server:

```bash
kiro-cli mcp add --name casper --agent <agent> --command casper --args mcp
```

To update, `npm install -g @joeyshi12/casper@latest`. Re-run
`casper service install` afterwards if you use the service: the unit records
absolute node and package paths, and both move on upgrade. Your token and sessions
survive.

To remove it:

```bash
casper service uninstall
npm uninstall -g @joeyshi12/casper
rm -rf ~/.casper ~/.config/casper   # only if you want sessions and settings gone too
```

## Configuration

Settings live in `~/.config/casper/config.json` (or `$XDG_CONFIG_HOME/casper/`),
written `0600` because it holds the token:

```json
{
  "port": 4319,
  "defaultCwd": "/home/you/projects",
  "fileRoot": "/home/you",
  "defaultAgent": "casper"
}
```

A missing or malformed file is ignored with a warning rather than failing startup,
and unrecognised keys are reported so a typo doesn't pass silently.

Every setting also works as an environment variable, and **the environment wins**,
which is handy for containers and one-off runs. Two are environment-only:
`CASPER_DATA_DIR`, because it says where data lives and so can't be read from
inside it, and `CASPER_WEB_DIST`, which is install layout rather than a preference.

| Variable | Config key | Default | |
|---|---|---|---|
| `HOST` | `host` | `0.0.0.0` | Bind address |
| `PORT` | `port` | `4319` | Server port |
| `CASPER_TOKEN` | `token` | _(generated)_ | Entered once at login, exchanged for a per-device cookie |
| `CASPER_SESSION_TTL_SECONDS` | `sessionTtlSeconds` | `604800` | Device-login lifetime, slid forward on activity |
| `KIRO_BIN` | `kiroBin` | `kiro-cli` | Path to the kiro-cli binary |
| `DEFAULT_CWD` | `defaultCwd` | cwd | Working directory for new sessions |
| `DEFAULT_AGENT` | `defaultAgent` | `kiro_default` | Agent for new sessions |
| `CASPER_FILE_ROOT` | `fileRoot` | `/` | Confines the file browser. Defaults to everything the server can read; narrow it to keep authenticated users out of system files |
| `MAX_LIVE_SESSIONS` | `maxLiveSessions` | `6` | Concurrent live kiro processes |
| `CASPER_DATA_DIR` | _(env only)_ | `~/.casper` | Where `casper.db` and uploaded files live |
| `CASPER_WEB_DIST` | _(env only)_ | beside the bundle | Built web app to serve |

Beyond your LAN, put a TLS-terminating reverse proxy in front of
`http://127.0.0.1:4319`, forwarding WebSocket upgrades with a long read timeout for
lengthy turns. PWA install and reliable reconnects need HTTPS.

## Security

Casper launches kiro with `--trust-all-tools` so unattended runs never block on
approvals. The agent can run commands and write files without asking, so treat
access to Casper as equivalent to a shell on the machine.

The token is 24 random bytes, generated for you and exchanged at login for a
per-device cookie; only its hash is stored. Comparison is constant-time, and
`/api/login` allows ten failures per quarter hour per address before answering 429.
The settings file and the database are both `0600`.

## Develop

```bash
npm install
CASPER_TOKEN=dev npm run dev   # server and web dev servers together
npm test
npm run e2e                    # prompt, disconnect mid-turn, reconnect, replay
```

The repo is an npm workspace: `shared/` for types, `web/` for the React app, and
`server/`, which is the package published to npm. `npm run build` bundles the server
with esbuild and copies the built web app in beside it.
