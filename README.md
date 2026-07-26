# Kalshi BTC 15-Minute Prediction Engine

TypeScript engine that streams Binance BTCUSDT data, tracks the active Kalshi `KXBTC15M` market, estimates settlement probability using a drift-adjusted z-score model (time-scaled realized volatility plus a momentum/order-flow drift term), and emits `HIGH` / `LOW` / `NO_BET` recommendations with paper trading and a dashboard.

The prediction is made **once, shortly after each 15-minute market opens, and locked** until the next interval. It is never revised mid-window, so the recorded history reflects genuine start-of-interval forecasts.

## Raspberry Pi (recommended for 24/7)

See [deploy/pi/README.md](deploy/pi/README.md) for full instructions.

```bash
git clone https://github.com/raymondmay95/kalshi-bet.git
cd kalshi-bet
bash deploy/pi/setup.sh
sudo systemctl enable --now kalshi-bet kalshi-bet-dashboard
```

Dashboard: `http://<pi-ip>:3000` · API: `http://<pi-ip>:3001`

## Advisory mode (no betting)

This engine does **not** place bets. It emits advisory signals:

- **HIGH** — conditions favor betting YES (BTC finishes above strike)
- **LOW** — conditions favor betting NO
- **NO_BET** — no clear edge after costs

Every signal is logged to Postgres. When a 15-minute window settles, the engine records the actual outcome and whether each signal was correct.

### Export history for model refinement

```bash
npm run export:history
# writes CSV to data/prediction-history-<timestamp>.csv
```

### Update on Pi

```bash
bash deploy/pi/pull-restart.sh
```

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
- `src/model/` — drift-adjusted z-score probability: `z = (P − K + μ·T_eff) / (σ·√T_eff)` with per-√second realized volatility, price-relative vol floor/cap, momentum + trade/book-imbalance drift (capped at 1.5σ), and log-odds shrinkage
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

## Learning from history

The engine improves itself as settled intervals accumulate — no manual retraining needed:

- **Probability calibration** (needs 100+ settled intervals): a Platt calibration is fit on `rawHighProbability` vs actual outcomes, replacing the fixed log-odds shrink. It is validated walk-forward (fit on the older 80%, tested on the newest 20%) and only used when it beats the fixed default on Brier score.
- **Volatility scale** (needs 30+ settled intervals): the predicted standard deviation is compared with realized lock-to-settle moves and corrected with a recency-weighted multiplier, clamped to 0.5x–2x.

Refitting happens at startup and after every settlement. Fitted parameters live in the `model_params` table with their fit metrics, and each prediction records which parameter set produced it (`model_params_id`), so generations can be compared. With no or insufficient history the engine uses fixed defaults.

## Notes

- Settlement uses CF Benchmarks BRTI 60-second average, not Binance last trade.
- Recommendations use executable Kalshi asks plus taker fees and slippage.
- Real order placement is intentionally disabled; paper trading only.
