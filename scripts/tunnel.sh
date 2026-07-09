#!/usr/bin/env bash
# Casper access helper - print the LAN URL, or open a public HTTPS tunnel.
#
#   scripts/tunnel.sh          # print the LAN address to open in a browser
#   scripts/tunnel.sh --public # start a cloudflared/ngrok HTTPS tunnel
set -euo pipefail

PORT="${PORT:-4319}"

lan_ip() {
  # Best-effort primary LAN IP across Linux/macOS.
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}'
  else
    ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

if [[ "${1:-}" == "--public" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    echo "Starting cloudflared tunnel to http://localhost:${PORT} …"
    exec cloudflared tunnel --url "http://localhost:${PORT}"
  elif command -v ngrok >/dev/null 2>&1; then
    echo "Starting ngrok tunnel to port ${PORT} …"
    exec ngrok http "${PORT}"
  else
    echo "Neither cloudflared nor ngrok found. Install one, or use LAN mode." >&2
    exit 1
  fi
fi

IP="$(lan_ip || true)"
echo "Casper is reachable on your LAN at:"
echo
echo "    http://${IP:-<your-lan-ip>}:${PORT}"
echo
echo "Open that on any device on the same network and paste your CASPER_TOKEN."
echo "For access from outside the network or to install as a PWA over HTTPS, run:"
echo "    scripts/tunnel.sh --public"
