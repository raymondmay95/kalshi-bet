# Kalshi BTC 15-Minute Prediction Engine

TypeScript engine that streams Binance BTCUSDT data, tracks the active Kalshi `KXBTC15M` market, estimates settlement probability using a drift-adjusted z-score model (time-scaled realized volatility plus a momentum/order-flow drift term), and emits `HIGH` / `LOW` / `NO_BET` recommendations with paper trading and a dashboard.

The engine continuously updates an analytical probability (about every 1–2 seconds) and runs settlement-aware Monte Carlo simulations on a worker thread on a cadence that speeds up near expiry. Directional forecasts and trade recommendations are separate fields.

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

This engine does **not** place real orders. Every tick it produces two separate
things:

1. **A call, always.** `HIGH` or `LOW`, with a certainty percentage — the model's
   probability that the call is right. There is no "undecided" state.
2. **A conviction grade**, which is what turns the call into a bet:

| Grade | Meaning |
|-------|---------|
| `STRONG` | Large edge, high confidence the edge is real. Stake near the cap. |
| `MODERATE` | Solid edge after costs. Normal stake. |
| `LEAN` | Thin but positive edge. Small speculative stake. |
| `PASS` | The market is priced fairly, or the trade cannot be executed. |

Only **execution problems** can force a `PASS` while an edge exists: stale data,
a missing or crossed quote, no resting size on the side we want, a spread too
wide to cross, or too little time left to get filled. A weak signal is a *small*
bet, not a refusal to decide.

Every signal is logged to Postgres. When a 15-minute window settles, the engine records the actual outcome and whether each signal was correct.

### How the edge is measured

Profit comes only from disagreeing with the market, so the engine compares its
own probability against the market's implied probability and charges the full
cost of trading:

```
edge = P(model) − (ask + Kalshi taker fee + expected slippage)
```

The fee is amortized over `ASSUMED_ORDER_SIZE` contracts, because Kalshi rounds
it up once per order — charging that rounding to a single contract inflates the
cost by up to a cent and is enough on its own to make every market look
unprofitable.

### How certainty is measured

The probability estimate carries a standard error, obtained by re-pricing the
market with the volatility and drift inputs perturbed by realistic amounts, plus
Monte Carlo sampling error and a floor for model misspecification. That gives two
distinct numbers the dashboard shows separately:

- **Certainty** — `P(the call is right)`, i.e. how confident the forecast is.
- **Edge confidence** — `P(edge > 0)`, i.e. how likely the edge is real rather
  than an artifact of estimation error. The same 3c edge scores lower on a noisy
  estimate than on a sharp one.

Position size is fractional Kelly on the edge *after* discounting it by half a
standard error, so a noisy edge is staked smaller than a clean one.

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

# Copy env and push schema (or apply SQL migration)
cp .env.example .env
npm run db:push
# alternatively: npm run db:migrate:sql

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

- `src/binance/` / `src/coinbase/` — spot WebSocket feeds + REST backfill
- `src/kalshi/` — KXBTC15M discovery, order book polling, settlement capture
- `src/market/` — rolling features and unified market state
- `src/model/` — lightweight analytical drift-adjusted z-score probability (1–2s updates)
- `src/prediction/` — Monte Carlo settlement-average engine in a persistent `worker_threads` pool, prediction scheduler, observability
- `src/decision/` — separates `predictedDirection` (`HIGH`/`LOW`) from `tradeRecommendation` (`BET_HIGH`/`BET_LOW`/`NO_BET`), grades conviction, and sizes the stake
- `src/storage/` — Drizzle + Postgres snapshots, predictions, paper trades, model metrics, retention cleanup
- `src/simulation/` — paper trader and settlement P&L
- `src/api/` — REST API + structured `/health` (`/api/live`, `/api/predictions`, `/api/performance`)
- `dashboard/` — Next.js UI: headline call with certainty, conviction grade, and a plain-English explanation on hover for every statistic (`dashboard/app/stat-definitions.ts`)

### Prediction pipeline (Pi-safe)

1. **Collector** (main thread) — WebSocket/REST ingestion; never awaits Monte Carlo or sync DB writes.
2. **Analytical predictor** — runs every ~2s or on material price/book/strike/time-threshold changes.
3. **Monte Carlo worker** — persistent worker thread; at most one pending job per market (newest wins); stale results discarded.
4. **Trainer** — adaptive Platt calibration + vol scale, refit after settlements (not continuous).
5. **Retention** — scheduled cleanup of old 1s snapshots and evaluated predictions.

`ALWAYS_PICK_SIDE` only adds an explicit "if forced to pick a side" note when passing; it never bypasses the execution blockers.

## MVP ladder

| MVP | Scope |
|-----|-------|
| 0 | Binance + Kalshi connections, 5s CLI snapshots |
| 1 | Full streams, Postgres snapshots, settlement recording |
| 2 | Feature engine, baseline model, decision engine |
| 3 | Paper trading, daily performance report |
| 4 | Next.js dashboard |

## Key parameters (defaults in `.env.example`)

| Parameter | Default | Effect |
|-----------|---------|--------|
| `MINIMUM_EDGE` | `0.01` | Smallest edge worth a `LEAN` |
| `MODERATE_EDGE` / `STRONG_EDGE` | `0.03` / `0.06` | Rungs for the higher grades |
| `MINIMUM_EDGE_CERTAINTY` | `0.55` | Minimum `P(edge > 0)` to act at all |
| `MAXIMUM_SPREAD` | `0.15` | Widest spread worth crossing |
| `MINIMUM_SECONDS_REMAINING` | `20` | Latest entry that can still be filled |
| `ASSUMED_ORDER_SIZE` | `20` | Contracts used to amortize the order-level fee |
| `KELLY_MULTIPLIER` | `0.25` | Fractional Kelly on the discounted edge |
| `MAXIMUM_STAKE_FRACTION` | `0.02` | Hard cap on bankroll risked per market |
| `VOL_RELATIVE_ERROR` | `0.30` | Assumed error in the realized-vol estimate |
| `MODEL_ERROR_FLOOR` | `0.02` | Irreducible probability error |
| `PAPER_TRADING` | `false` | Simulate fills and P&L |

Raising `MINIMUM_EDGE` and `MINIMUM_EDGE_CERTAINTY` makes the engine pickier;
setting `MINIMUM_EDGE` above roughly `0.05` will make bets very rare, since the
model then has to beat the market's own mid by more than the spread plus costs.

## Learning from history

The engine improves itself as settled intervals accumulate — no manual retraining needed:

- **Probability calibration** (needs 100+ settled intervals): a Platt calibration is fit on `rawHighProbability` vs actual outcomes, replacing the fixed log-odds shrink. It is validated walk-forward (fit on the older 80%, tested on the newest 20%) and only used when it beats the fixed default on Brier score.
- **Volatility scale** (needs 30+ settled intervals): the predicted standard deviation is compared with realized lock-to-settle moves and corrected with a recency-weighted multiplier, clamped to 0.5x–2x.

Refitting happens at startup and after every settlement. Fitted parameters live in the `model_params` table with their fit metrics, and each prediction records which parameter set produced it (`model_params_id`), so generations can be compared. With no or insufficient history the engine uses fixed defaults.

## Notes

- Settlement uses CF Benchmarks BRTI 60-second average, not Binance last trade. The gap between that and our spot feed is part of `MODEL_ERROR_FLOOR`.
- Recommendations use executable Kalshi asks plus taker fees and slippage.
- Real order placement is intentionally disabled; paper trading only.
