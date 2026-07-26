#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"
RUN_GROUP="${RUN_GROUP:-$(id -gn "$RUN_USER")}"

find_bin() {
  local name="$1"
  local candidate=""

  candidate="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$candidate" ]]; then
    echo "$candidate"
    return
  fi

  for candidate in "/usr/bin/$name" "/usr/local/bin/$name"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done

  if [[ -n "${SUDO_USER:-}" ]]; then
    candidate="$(sudo -u "$RUN_USER" -i command -v "$name" 2>/dev/null || true)"
    if [[ -n "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  fi

  return 1
}

NODE_BIN="$(find_bin node || true)"
NPM_BIN="$(find_bin npm || true)"
DOCKER_BIN="$(find_bin docker || true)"

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "ERROR: Could not find node/npm."
  echo "Install Node.js first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi

if [[ -z "$DOCKER_BIN" ]]; then
  echo "ERROR: Could not find docker."
  echo "Install Docker first: curl -fsSL https://get.docker.com | sudo sh"
  exit 1
fi

if [[ ! -f "$ROOT_DIR/dist/src/index.js" ]]; then
  echo "ERROR: Engine not built yet. Run from $ROOT_DIR:"
  echo "  npm install && npm run build"
  exit 1
fi

if [[ ! -f "$ROOT_DIR/dashboard/.env.local" ]]; then
  PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -z "$PI_IP" ]]; then
    PI_IP="127.0.0.1"
  fi
  cat > "$ROOT_DIR/dashboard/.env.local" <<EOF
NEXT_PUBLIC_API_BASE=http://${PI_IP}:3001
EOF
  chown "$RUN_USER:$RUN_GROUP" "$ROOT_DIR/dashboard/.env.local" 2>/dev/null || true
  echo "Created $ROOT_DIR/dashboard/.env.local"
fi

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  chown "$RUN_USER:$RUN_GROUP" "$ROOT_DIR/.env" 2>/dev/null || true
  echo "Created $ROOT_DIR/.env"
fi

if [[ $EUID -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo INSTALL_DIR="$ROOT_DIR" RUN_USER="$RUN_USER" RUN_GROUP="$RUN_GROUP" "$0"
fi

render_service() {
  local template="$1"
  local target="$2"
  sed \
    -e "s|@INSTALL_DIR@|${ROOT_DIR}|g" \
    -e "s|@NODE_BIN@|${NODE_BIN}|g" \
    -e "s|@NPM_BIN@|${NPM_BIN}|g" \
    -e "s|@DOCKER_BIN@|${DOCKER_BIN}|g" \
    -e "s|@RUN_USER@|${RUN_USER}|g" \
    -e "s|@RUN_GROUP@|${RUN_GROUP}|g" \
    "$template" > "$target"
  chmod 644 "$target"
  echo "Wrote $target"
}

render_service "$ROOT_DIR/deploy/pi/kalshi-bet.service" /etc/systemd/system/kalshi-bet.service
render_service "$ROOT_DIR/deploy/pi/kalshi-bet-dashboard.service" /etc/systemd/system/kalshi-bet-dashboard.service

systemctl daemon-reload

if [[ ! -f /etc/systemd/system/kalshi-bet.service ]]; then
  echo "ERROR: Service file was not created."
  exit 1
fi

echo ""
echo "Installed systemd units:"
echo "  User:        $RUN_USER"
echo "  Install dir: $ROOT_DIR"
echo "  Node:        $NODE_BIN"
echo "  Docker:      $DOCKER_BIN"
echo ""
echo "Next:"
echo "  sudo systemctl enable --now kalshi-bet kalshi-bet-dashboard"
