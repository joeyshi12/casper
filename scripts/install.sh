#!/usr/bin/env bash
# Casper installer. Clones (or updates) the repo, builds it, and installs a
# `casper` command. Where a user systemd is available it also runs Casper as a
# service that survives logout and reboot; otherwise you start it with `casper`
# (or wire that command into your own init system). Safe to re-run: it updates
# an existing install in place and preserves your token.
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

# --- Casper kiro agent -----------------------------------------------------
# Soft-link the bundled agent into kiro's global agent dir so `--agent casper`
# resolves from any working directory. Idempotent and non-destructive: an
# existing real (non-symlink) casper.json is left untouched. DEFAULT_AGENT is
# set to casper only when the agent is actually resolvable, else kiro_default.
AGENT_SRC="$DIR/assets/agents/casper.json"
AGENT_DIR="$HOME/.kiro/agents"
AGENT_LINK="$AGENT_DIR/casper.json"
AGENT_NAME="kiro_default"
if [ -f "$AGENT_SRC" ]; then
  mkdir -p "$AGENT_DIR"
  if [ -e "$AGENT_LINK" ] && [ ! -L "$AGENT_LINK" ]; then
    printf '\033[33m! %s exists and is not a Casper symlink; leaving it as-is.\033[0m\n' "$AGENT_LINK"
  else
    ln -sfn "$AGENT_SRC" "$AGENT_LINK"
    ok "Linked Casper agent into $AGENT_DIR"
  fi

  if command -v kiro-cli >/dev/null 2>&1; then
    if kiro-cli agent validate --path "$AGENT_LINK" >/dev/null 2>&1; then
      AGENT_NAME="casper"
    else
      printf '\033[33m! casper agent failed validation; falling back to kiro_default.\033[0m\n'
    fi
  else
    AGENT_NAME="casper"
  fi
fi

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
CASPER_NODE=$NODE_BIN
NODE_ENV=production
DEFAULT_AGENT=$AGENT_NAME
EOF
ok "Wrote $ENV_FILE"

# --- casper command --------------------------------------------------------
# Put a `casper` command on PATH that runs the server in the foreground. It is
# what the service below launches, and it also lets you run Casper by hand on a
# machine without a user systemd - or under a completely different init system.
CASPER_SCRIPT="$DIR/scripts/casper"
BIN_DIR="$HOME/.local/bin"
BIN_LINK="$BIN_DIR/casper"
chmod +x "$CASPER_SCRIPT" 2>/dev/null || true
mkdir -p "$BIN_DIR"
ln -sfn "$CASPER_SCRIPT" "$BIN_LINK"
ok "Linked casper command into $BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) printf '\033[33m! %s is not on your PATH; add it to run `casper` directly.\033[0m\n' "$BIN_DIR" ;;
esac

# --- Run as a service (systemd user), if available -------------------------
# systemd in user mode is optional. If it isn't available - no systemd, or user
# services aren't permitted - we skip the service and you run Casper yourself
# with the `casper` command (directly, via nohup, or your own init system).
HAS_USER_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  HAS_USER_SYSTEMD=1
fi

SERVICE_ACTIVE=0
if [ "$HAS_USER_SYSTEMD" = 1 ]; then
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
ExecStart=$CASPER_SCRIPT start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

  # Keep the service running after logout / across reboots.
  loginctl enable-linger "$USER" >/dev/null 2>&1 || \
    printf '\033[33m! Could not enable linger; service may stop on logout. Run: sudo loginctl enable-linger %s\033[0m\n' "$USER"

  systemctl --user daemon-reload || true
  systemctl --user enable --now "$SERVICE" >/dev/null 2>&1 || true
  sleep 1

  if systemctl --user is-active --quiet "$SERVICE"; then
    SERVICE_ACTIVE=1
    ok "Casper is running as a systemd user service"
  else
    printf '\033[33m! Service did not start; run Casper directly with: casper\033[0m\n'
    printf '\033[33m  (details: systemctl --user status %s)\033[0m\n' "$SERVICE"
  fi
else
  say "No user systemd detected; skipping service setup"
  ok "Run Casper with the installed 'casper' command"
fi

# --- Done ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$SERVICE_ACTIVE" = 1 ]; then
  printf '\n\033[32m👻 Casper is installed and running.\033[0m\n\n'
  printf '  Open:   http://%s:%s   (or http://localhost:%s)\n' "${IP:-<this-host>}" "$PORT" "$PORT"
  printf '  Token:  %s\n\n' "$TOKEN"
  printf '  Status/logs: systemctl --user status %s   |   journalctl --user -u %s -f\n' "$SERVICE" "$SERVICE"
  printf '  Run by hand: casper        (the service launches this same command)\n'
else
  printf '\n\033[32m👻 Casper is installed.\033[0m\n\n'
  printf '  Start it:  casper          (foreground; Ctrl-C to stop)\n'
  printf '             or background it via your init system (OpenRC, runit, ...), nohup, or tmux\n\n'
  printf '  Then open: http://%s:%s   (or http://localhost:%s)\n' "${IP:-<this-host>}" "$PORT" "$PORT"
  printf '  Token:     %s\n' "$TOKEN"
fi
printf '  Update:    re-run this installer\n'
printf '  Uninstall: %s/scripts/uninstall.sh\n\n' "$DIR"
