#!/usr/bin/env bash
# One-time setup for Raspberry Pi (64-bit Raspberry Pi OS recommended).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[setup] $*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }; }

log "Installing from: $ROOT_DIR"

if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "armv7l" ]]; then
  log "Warning: this script is intended for Raspberry Pi / ARM Linux."
fi

install_node() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.version.replace("v","").split(".")[0]')" -ge 20 ]]; then
    log "Node.js $(node -v) already installed"
    return
  fi

  log "Installing Node.js 22.x..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  log "Node.js $(node -v) installed"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed"
  else
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" || true
    log "Docker installed (log out/in if docker group was added)"
  fi

  if ! docker compose version >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
  fi
}

install_node
install_docker

log "Installing npm dependencies..."
npm install
npm install --prefix dashboard

ensure_env_files() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    log "Created .env from .env.example"
  fi
  if ! grep -q '^PRICE_FEED=' .env 2>/dev/null; then
    echo "PRICE_FEED=coinbase" >> .env
    log "Set PRICE_FEED=coinbase in .env"
  fi
  if [[ ! -f dashboard/.env.local ]]; then
    PI_IP="$(hostname -I | awk '{print $1}')"
    cat > dashboard/.env.local <<EOF
NEXT_PUBLIC_API_BASE=http://${PI_IP}:3001
EOF
    log "Created dashboard/.env.local with API base http://${PI_IP}:3001"
  fi
}

ensure_env_files

log "Building engine..."
npm run build

log "Building dashboard..."
npm run build --prefix dashboard

log "Starting Postgres..."
docker compose up -d

log "Waiting for Postgres..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U kalshi -d kalshi_bet >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

log "Applying database schema..."
npm run db:push || log "WARNING: db:push failed — you can retry with: npm run db:push"
npm run db:migrate:sql || log "WARNING: SQL migration helper failed — schema may already be current"

log "Installing systemd services..."
bash deploy/pi/install-services.sh

log ""
log "Setup complete."
log "  Start engine:    sudo systemctl start kalshi-bet"
log "  Start dashboard: sudo systemctl start kalshi-bet-dashboard"
log "  Enable on boot:  sudo systemctl enable kalshi-bet kalshi-bet-dashboard"
log "  Engine logs:     journalctl -u kalshi-bet -f"
log "  Dashboard:       http://$(hostname -I | awk '{print $1}'):3000"
