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

<p align="center">
<img src="https://raw.githubusercontent.com/joeyshi12/casper/main/assets/demo.webp" alt="Casper on a new chat: picking the effort, a task whose tool calls fold into one line, two subagents reviewing the change, and pinning the chat" width="100%"/>
</p>

## Features

- **Chats** you can search, rename, pin, group by date, edit and branch. Idle ones go
  dormant and resume on demand.
- **Model, effort and agent** per chat, with titles from kiro and live context usage
  and credits.
- **Rich rendering** of Markdown, Mermaid, code and tool calls, a file browser for the
  workspace, subagent transcripts, inline widgets from a `show_widget` MCP tool, and
  options from a `show_choice` tool that wait for you to tap one or type a reply.
- **Settings** for kiro's defaults, MCP servers and skills, and your logged-in devices.
- **PWA** that installs to a home screen.

## Install

Needs Node 24+ and [`kiro-cli`](https://kiro.dev) 3.x, installed and logged in.

```bash
npm install -g @joeyshi12/casper
casper                     # prints an access token and the URL to open
casper service install     # optional: a systemd user service that survives reboots
```

| Command | |
|---|---|
| `casper token` | Print the access token |
| `casper reset-token [value]` | Set a new token and sign every device out |
| `casper doctor` | Check kiro-cli, settings, data directory, web app and MCP server |
| `casper mcp` | Run the widget MCP server on stdio (kiro spawns this for you) |
| `casper service install \| uninstall \| status` | Manage the systemd user service |

The `casper` agent gets the widget tools. To give them to another agent:
`kiro-cli mcp add --name casper --agent <agent> --command casper --args mcp`.

To update, install `@joeyshi12/casper@latest` and re-run `casper service install`,
since the unit records paths that move on upgrade. To remove it, run
`casper service uninstall`, `npm uninstall -g @joeyshi12/casper`, and delete
`~/.casper` and `~/.config/casper` if you want the data gone.

## Configuration

Settings live in `~/.config/casper/config.json` (written `0600`). The few that differ
per launch can also be set in the environment, which wins over the file.

| Config key | Variable | Default | |
|---|---|---|---|
| `host` | `CASPER_HOST` | `0.0.0.0` | Bind address |
| `port` | `CASPER_PORT` | `4319` | Server port |
| `token` | `CASPER_TOKEN` | _(generated)_ | Exchanged at login for a per-device cookie |
| `kiroBin` | `CASPER_KIRO_BIN` | `kiro-cli` | Path to kiro-cli |
| `defaultCwd` | | cwd | Working directory for new chats |
| `defaultAgent` | | `casper` | Agent for new chats when kiro's `chat.defaultAgent` is unset |
| `fileRoot` | | `/` | The only folder the file browser can read |
| `kiroSessionsDir` | | `~/.kiro/sessions` | kiro's session files, which Casper reads |
| `maxLiveSessions` | | `6` | Concurrent kiro processes |
| `maxUploadBytes` | | `104857600` | Largest uploaded file |
| _(env only)_ | `CASPER_DATA_DIR` | `~/.casper` | Where `casper.db` and uploads live |
| _(env only)_ | `CASPER_WEB_DIST` | beside the bundle | Built web app to serve |

Earlier versions read more variables, such as `HOST`, `PORT` and `MAX_LIVE_SESSIONS`.
Casper logs a warning at startup for any that are still set.

Beyond your LAN, put a TLS reverse proxy in front that forwards WebSocket upgrades
with a long read timeout. The PWA needs HTTPS.

## Security

Casper allows every tool call kiro asks about, once, so treat access to Casper as a
shell on the machine. kiro's deny rules still apply, and no "always allow" rule is
saved. The token is stored only as a hash, and `/api/login` allows ten failures per
quarter hour per address.

## Develop

```bash
npm install
CASPER_TOKEN=dev npm run dev   # server and web dev servers together
npm test
npm run e2e                    # prompt, disconnect mid-turn, reconnect, replay
```

`shared/` holds the types, `web/` the React app, and `server/` the published package.
See [AGENTS.md](AGENTS.md) for the rest.
