# Kalshi BTC 15-Minute Prediction Engine

TypeScript engine that streams Binance BTCUSDT data, tracks the active Kalshi `KXBTC15M` market, estimates settlement probability using a baseline z-score model adjusted for 60-second BRTI averaging, and emits `HIGH` / `LOW` / `NO_BET` recommendations with paper trading and a dashboard.

## Raspberry Pi (recommended for 24/7)

See [deploy/pi/README.md](deploy/pi/README.md) for full instructions.

```bash
git clone https://github.com/raymondmay95/kalshi-bet.git
cd kalshi-bet
bash deploy/pi/setup.sh
sudo systemctl enable --now kalshi-bet kalshi-bet-dashboard
```

Dashboard: `http://<pi-ip>:3000` · API: `http://<pi-ip>:3001`

## Quick start (development)

```bash
# Install dependencies
npm install

# Start Postgres
docker compose up -d

# Copy env and push schema
cp .env.example .env
npm run db:push

# Run engine (Binance + Kalshi + predictions + API on :3001)
npm run dev

# Run tests
npm test

# Daily report
npm run report:daily

# Dashboard (separate terminal)
cd dashboard && npm install && cp .env.local.example .env.local && npm run dev
```

## Architecture

- `src/binance/` — WebSocket feed (aggTrade, bookTicker, depth20, kline_1m) + REST backfill
- `src/kalshi/` — KXBTC15M discovery, order book polling, settlement capture
- `src/market/` — rolling features and unified market state
- `src/model/` — baseline probability with `T_eff = max(secondsRemaining - 30, 1)`
- `src/decision/` — Kalshi fee formula, EV, filters, recommendation output
- `src/storage/` — Drizzle + Postgres snapshots, predictions, paper trades
- `src/simulation/` — paper trader and settlement P&L
- `src/api/` — REST API for dashboard (`/api/live`, `/api/predictions`, `/api/performance`)
- `dashboard/` — Next.js UI with live chart and recommendation card

## MVP ladder

| MVP | Scope |
|-----|-------|
| 0 | Binance + Kalshi connections, 5s CLI snapshots |
| 1 | Full streams, Postgres snapshots, settlement recording |
| 2 | Feature engine, baseline model, decision engine |
| 3 | Paper trading, daily performance report |
| 4 | Next.js dashboard |

## Key parameters (defaults in `.env.example`)

- `MINIMUM_EDGE=0.07`
- `MINIMUM_CONFIDENCE=0.70`
- `MAXIMUM_SPREAD=0.08`
- `MINIMUM_SECONDS_REMAINING=90`
- `PAPER_TRADING=true`

## Notes

- Settlement uses CF Benchmarks BRTI 60-second average, not Binance last trade.
- Recommendations use executable Kalshi asks plus taker fees and slippage.
- Real order placement is intentionally disabled; paper trading only.
