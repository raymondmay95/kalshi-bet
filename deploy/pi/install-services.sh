#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"
RUN_GROUP="${RUN_GROUP:-$(id -gn "$RUN_USER")}"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "node and npm must be on PATH"
  exit 1
fi

render_service() {
  local template="$1"
  local target="$2"
  sed \
    -e "s|@INSTALL_DIR@|${ROOT_DIR}|g" \
    -e "s|@NODE_BIN@|${NODE_BIN}|g" \
    -e "s|@NPM_BIN@|${NPM_BIN}|g" \
    -e "s|@RUN_USER@|${RUN_USER}|g" \
    -e "s|@RUN_GROUP@|${RUN_GROUP}|g" \
    "$template" | sudo tee "$target" >/dev/null
}

render_service "$ROOT_DIR/deploy/pi/kalshi-bet.service" /etc/systemd/system/kalshi-bet.service
render_service "$ROOT_DIR/deploy/pi/kalshi-bet-dashboard.service" /etc/systemd/system/kalshi-bet-dashboard.service

sudo systemctl daemon-reload
echo "Installed systemd units for $ROOT_DIR"
