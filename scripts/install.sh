#!/usr/bin/env bash
# Casper installer. Clones (or updates) the repo, builds it, and runs it as a
# systemd user service that survives logout and reboot. Safe to re-run: it
# updates an existing install in place and preserves your token.
#
#   curl -fsSL <install-url> | bash
#
# Overridable via env: CASPER_REPO, CASPER_DIR, CASPER_PORT, CASPER_BRANCH.
set -euo pipefail

REPO="${CASPER_REPO:-https://github.com/joeyshi12/casper.git}"
BRANCH="${CASPER_BRANCH:-main}"
DIR="${CASPER_DIR:-$HOME/.local/share/casper}"
PORT="${CASPER_PORT:-4319}"
SERVICE="casper"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$SERVICE.service"

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required but not installed."
command -v node >/dev/null 2>&1 || die "Node.js is required but not installed (need 18.20+)."
command -v npm  >/dev/null 2>&1 || die "npm is required but not installed."
command -v systemctl >/dev/null 2>&1 || die "systemd is required (this installer targets Linux with systemd)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18.20+ required; found $(node -v)."

NODE_BIN="$(command -v node)"

if ! command -v kiro-cli >/dev/null 2>&1; then
  printf '\033[33m! kiro-cli not found on PATH. Install it and run `kiro-cli login` before using Casper.\033[0m\n'
fi

# --- Fetch / update source -------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating existing install at $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" reset --hard --quiet "origin/$BRANCH"
else
  say "Cloning Casper into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

# --- Build -----------------------------------------------------------------
say "Installing dependencies"
( cd "$DIR" && npm ci --silent )
say "Building (shared, server, web). This can take a minute"
( cd "$DIR" && npm run build >/dev/null )
ok "Build complete"

# --- Configure -------------------------------------------------------------
ENV_FILE="$DIR/.env"
if [ -f "$ENV_FILE" ] && grep -q '^CASPER_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(grep '^CASPER_TOKEN=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
  say "Keeping existing access token"
else
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  say "Generated a new access token"
fi

cat > "$ENV_FILE" <<EOF
HOST=0.0.0.0
PORT=$PORT
CASPER_TOKEN=$TOKEN
CASPER_WEB_DIST=$DIR/web/dist
NODE_ENV=production
EOF
ok "Wrote $ENV_FILE"

# --- systemd user service --------------------------------------------------
say "Installing systemd user service"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Casper (kiro-cli web client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

# Keep the service running after logout / across reboots.
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  printf '\033[33m! Could not enable linger; service may stop on logout. Run: sudo loginctl enable-linger %s\033[0m\n' "$USER"

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE" >/dev/null
sleep 1

if systemctl --user is-active --quiet "$SERVICE"; then
  ok "Casper is running"
else
  die "Service failed to start. Check: systemctl --user status $SERVICE"
fi

# --- Done ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n\033[32m👻 Casper is installed and running.\033[0m\n\n'
printf '  Open:   http://%s:%s   (or http://localhost:%s)\n' "${IP:-<this-host>}" "$PORT" "$PORT"
printf '  Token:  %s\n\n' "$TOKEN"
printf '  Logs:      systemctl --user status %s   |   journalctl --user -u %s -f\n' "$SERVICE" "$SERVICE"
printf '  Update:    re-run this installer\n'
printf '  Uninstall: %s/scripts/uninstall.sh\n\n' "$DIR"
