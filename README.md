# 👻 Casper

A web client for `kiro-cli`, over its Agent Client Protocol (ACP).
Start a long Kiro task and it keeps running server-side tab.
On reconnect the client replays exactly what it missed.

## Features

- **Sessions** - create, search, rename, switch, and delete. Live sessions run
  in a bounded process pool; idle ones go dormant and resume on demand.
- **Per-session model & agent** - from the live model list and kiro's agents.
- **Rich rendering** - Markdown, Mermaid diagrams, syntax-highlighted code, and
  MCP tool calls with status/input/output.
- **Observability** - credits spent, context-window usage, and turn duration.
- **PWA** - installable, responsive, auto-reconnects on unlock/network return.

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
| `CASPER_TOKEN` | _(empty)_ | Shared secret required on REST + WS. **Set before exposing.** |
| `KIRO_BIN` | `kiro-cli` | Path to the kiro-cli binary |
| `DEFAULT_CWD` | cwd | Default working directory for new sessions |
| `MAX_LIVE_SESSIONS` | `6` | Max concurrent live kiro processes |
| `DEFAULT_AGENT` | `kiro_default` | Default agent for new sessions |
| `CASPER_WEB_DIST` | `../web/dist` | Built web app to serve (set to an absolute path in prod) |

## Deploy on a Linux server

The server serves the built web app and the API/WebSocket on a single port, so
there's one process to run.

**1. Prerequisites.** Install Node 18.20+, then install and authenticate
`kiro-cli` **as the user the service will run as** (Casper spawns it and inherits
that login):

```bash
kiro-cli login       # or: kiro-cli whoami  to confirm you're already logged in
```

**2. Get the code and build:**

```bash
git clone <your-fork-url> /opt/casper && cd /opt/casper
npm ci
npm run build        # builds shared, server, and web
```

**3. Configure.** Create `/opt/casper/.env`:

```ini
HOST=0.0.0.0
PORT=4319
CASPER_TOKEN=<paste a long random secret>
CASPER_WEB_DIST=/opt/casper/web/dist
DEFAULT_CWD=/home/casper/workspace
NODE_ENV=production
```

Generate the token with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

**4. Run it under systemd** - `/etc/systemd/system/casper.service`:

```ini
[Unit]
Description=Casper (kiro-cli web client)
After=network.target

[Service]
Type=simple
User=casper
WorkingDirectory=/opt/casper/server
EnvironmentFile=/opt/casper/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` must be the `server/` dir (that's where `node dist/index.js`
lives). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now casper
sudo systemctl status casper        # or: journalctl -u casper -f
```

**5. HTTPS (recommended).** Terminate TLS with a reverse proxy - required for PWA
install and for reconnect-on-unlock to work over cellular. Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name casper.example.com;
    # ssl_certificate / ssl_certificate_key from certbot, etc.

    location / {
        proxy_pass http://127.0.0.1:4319;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;                    # long agent turns
    }
}
```

To update: `git pull && npm ci && npm run build && sudo systemctl restart casper`.

## Verify

```bash
npm test        # unit: observability fold
npm run probe   # raw ACP bridge (spawns real kiro-cli, costs a few credits)
npm run e2e     # full server: prompt, disconnect mid-turn, reconnect, replay
```

## Security

Casper launches kiro with `--trust-all-tools` so unattended runs never block on
approvals - the agent can run commands and write files without confirmation.
Always set `CASPER_TOKEN` and put the server behind HTTPS before exposing it.
# casper
