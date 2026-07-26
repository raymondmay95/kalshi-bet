#!/usr/bin/env bash
# Pull latest code and restart services on the Pi.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[update] $*"; }

log "Pulling latest changes..."
git pull --ff-only

log "Installing dependencies..."
npm install
npm install --prefix dashboard

log "Building..."
npm run build
npm run build --prefix dashboard

if docker compose ps postgres 2>/dev/null | grep -q running; then
  npm run db:push || log "db:push skipped or failed (schema may already be current)"
fi

log "Restarting services..."
sudo systemctl restart kalshi-bet
sudo systemctl restart kalshi-bet-dashboard

log "Done. Check status with: systemctl status kalshi-bet kalshi-bet-dashboard"
