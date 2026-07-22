#!/usr/bin/env bash
# Casper uninstaller. Stops and removes the systemd user service and deletes the
# install directory. By default it leaves your session data (~/.casper) alone;
# pass --purge to remove that too.
#
#   ~/.local/share/casper/scripts/uninstall.sh [--purge]
#   curl -fsSL <uninstall-url> | bash
set -euo pipefail

DIR="${CASPER_DIR:-$HOME/.local/share/casper}"
SERVICE="casper"
UNIT="$HOME/.config/systemd/user/$SERVICE.service"
DATA_DIR="${CASPER_DATA_DIR:-$HOME/.casper}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }

# --- Stop and remove the service ------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  say "Stopping and disabling the service"
  systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
  if [ -f "$UNIT" ]; then
    rm -f "$UNIT"
    systemctl --user daemon-reload
  fi
  ok "Service removed"
fi

# --- Remove the Casper kiro agent symlink ---------------------------------
AGENT_LINK="$HOME/.kiro/agents/casper.json"
if [ -L "$AGENT_LINK" ]; then
  say "Removing Casper agent symlink"
  rm -f "$AGENT_LINK"
  ok "Agent symlink removed"
elif [ -e "$AGENT_LINK" ]; then
  printf '\033[33m! Kept %s (not a Casper symlink).\033[0m\n' "$AGENT_LINK"
fi

# --- Remove the install directory -----------------------------------------
if [ -d "$DIR" ]; then
  say "Removing install directory $DIR"
  rm -rf "$DIR"
  ok "Files removed"
else
  say "No install directory at $DIR"
fi

# --- Optionally remove session data ---------------------------------------
if [ "$PURGE" -eq 1 ]; then
  if [ -d "$DATA_DIR" ]; then
    say "Purging session data $DATA_DIR"
    rm -rf "$DATA_DIR"
    ok "Session data removed"
  fi
else
  printf '\033[33m! Kept session data at %s (run with --purge to remove it).\033[0m\n' "$DATA_DIR"
fi

printf '\n\033[32m👻 Casper has been uninstalled.\033[0m\n'
printf '  Note: kiro-cli and its login were not touched.\n'
