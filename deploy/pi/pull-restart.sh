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

# Backfill any setting added to .env.example since this .env was created. Only
# absent keys are appended; existing values are never overwritten, so deliberate
# tuning survives a deploy. Values already in use are reported by check:env.
backfilled=()
while IFS= read -r key; do
  if ! grep -q "^${key}=" .env 2>/dev/null; then
    grep "^${key}=" .env.example >> .env
    backfilled+=("$key")
  fi
done < <(grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | tr -d '=')

if [[ ${#backfilled[@]} -gt 0 ]]; then
  log "Added ${#backfilled[@]} new setting(s) to .env: ${backfilled[*]}"
fi

log "Starting Postgres..."
docker compose up -d

log "Applying database schema..."
npm run db:push
npm run db:migrate:sql || log "WARNING: SQL migration helper failed — schema may already be current"

log "Auditing configuration..."
if ! npm run --silent check:env; then
  log "WARNING: the configuration above will suppress bets — fix .env and re-run"
fi

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
