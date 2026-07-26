#!/usr/bin/env bash
# Pull latest code, migrate DB, rebuild, and restart services on the Pi.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[pull-restart] $*"; }

log "Pulling latest changes..."
git pull --ff-only

log "Installing dependencies..."
npm install
npm install --prefix dashboard

if [[ ! -f .env ]]; then
  cp .env.example .env
  log "Created .env from .env.example"
fi

if ! grep -q '^PRICE_FEED=' .env 2>/dev/null; then
  echo "PRICE_FEED=coinbase" >> .env
fi

if ! grep -q '^API_HOST=' .env 2>/dev/null; then
  echo "API_HOST=0.0.0.0" >> .env
fi

if ! grep -q '^PAPER_TRADING=' .env 2>/dev/null; then
  echo "PAPER_TRADING=false" >> .env
fi

if ! grep -q '^ALWAYS_PICK_SIDE=' .env 2>/dev/null; then
  echo "ALWAYS_PICK_SIDE=true" >> .env
fi

log "Starting Postgres..."
docker compose up -d

log "Applying database schema..."
npm run db:push

log "Building engine and dashboard..."
npm run build
npm run build --prefix dashboard

if [[ ! -f dashboard/.env.local ]]; then
  PI_IP="$(hostname -I | awk '{print $1}')"
  echo "NEXT_PUBLIC_API_BASE=http://${PI_IP}:3001" > dashboard/.env.local
fi

log "Restarting services..."
sudo systemctl restart kalshi-bet
sudo systemctl restart kalshi-bet-dashboard

sleep 2
log "Health check..."
curl -sf http://127.0.0.1:3001/health >/dev/null && log "Engine API OK" || log "WARNING: Engine API not responding yet"

log "Done."
log "  Dashboard: http://$(hostname -I | awk '{print $1}'):3000"
log "  Export history: npm run export:history"
