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
| `MINIMUM_EDGE` | `0.02` | Smallest edge worth a `LEAN` |
| `MODERATE_EDGE` / `STRONG_EDGE` | `0.04` / `0.07` | Rungs for the higher grades |
| `MINIMUM_EDGE_CERTAINTY` | `0.60` | Minimum `P(edge > 0)` to act at all |
| `MAXIMUM_SPREAD` | `0.15` | Widest spread worth crossing |
| `MINIMUM_SECONDS_REMAINING` | `20` | Latest entry that can still be filled |
| `MINIMUM_LIQUIDITY` | `20` | Contracts that must be resting on the chosen side |
| `ASSUMED_ORDER_SIZE` | `20` | Contracts used to amortize the order-level fee |
| `KELLY_MULTIPLIER` | `0.25` | Fractional Kelly on the discounted edge |
| `MAXIMUM_STAKE_FRACTION` | `0.02` | Hard cap on bankroll risked per market |
| `SLIPPAGE_CENTS` | `0.005` | Assumed drift between the quote and the fill |
| `VOL_RELATIVE_ERROR` | `0.30` | Assumed error in the realized-vol estimate |
| `MODEL_ERROR_FLOOR` | `0.02` | Irreducible probability error while the basis is unmeasured |
| `MEASURED_BASIS_ERROR_FLOOR` | `0.01` | Replaces the above once the basis is measured |
| `PAPER_TRADING` | `false` | Simulate fills and P&L |

### Choosing the edge floor

`MINIMUM_EDGE` is the parameter that decides whether the engine ever bets, and
it is easy to set to a value no market can clear. The edge is measured against
the *ask*, so at a 4c spread the model must beat the market's own mid by
`MINIMUM_EDGE` plus half the spread plus about 2.3c of fees and slippage:

| `MINIMUM_EDGE` | Disagreement with the mid needed for a `LEAN` |
|----------------|-----------------------------------------------|
| `0.01` | 5.3c |
| `0.02` | 6.3c |
| `0.04` | 8.3c |
| `0.07` | 11.3c — effectively unreachable |

`0.02` is the lowest useful floor. Below it, the half-standard-error haircut
applied during sizing drives the discounted edge negative, Kelly returns zero,
and every bet collapses to `MINIMUM_STAKE_FRACTION` — an actionable signal with
a token stake. `MINIMUM_LIQUIDITY` should stay equal to `ASSUMED_ORDER_SIZE`,
since amortizing the fee over more contracts than the book must show overstates
every edge.

### Auditing the configuration

Two failure modes make a healthy-looking engine that never bets: a key renamed
in code but left behind in `.env` is silently ignored, and an edge floor can be
set higher than any market can clear. Both are reported by:

```bash
npm run check:env
```

It lists ignored keys, settings missing from `.env`, the effective gates, and
the disagreement with the market that the current floor demands. `deploy/pi/pull-restart.sh`
runs it on every deploy and backfills newly added settings, but never overwrites
a value already in `.env`.

## Learning from history

The engine improves itself as settled intervals accumulate — no manual retraining needed:

- **Probability calibration** (needs 100+ settled intervals): a Platt calibration is fit on `rawHighProbability` vs actual outcomes, replacing the fixed log-odds shrink. It is validated walk-forward (fit on the older 80%, tested on the newest 20%) and only used when it beats the fixed default on Brier score.
- **Volatility scale** (needs 30+ settled intervals): the predicted standard deviation is compared with realized lock-to-settle moves and corrected with a recency-weighted multiplier, clamped to 0.5x–2x.
- **Settlement basis** (needs 500+ settled intervals, 75+ of them near the strike): the gap between our spot feed and the BRTI average that settles the market, measured rather than assumed. See below.

### Measuring the settlement basis

The market settles on the CF Benchmarks BRTI 60-second average, not on our spot
feed, and Kalshi's API returns only the binary result — never the numeric BRTI
value. The basis therefore cannot be differenced directly, but it can be
recovered from the outcomes. Writing `distance` for our own final-minute average
minus the strike:

```
P(settles HIGH) = Phi((distance + offset) / basisStdDev)
```

Fitting that two-parameter probit to settled intervals recovers both a
systematic `offset` (our venue trading persistently rich or cheap to the index)
and the interval-to-interval `basisStdDev`. The market's own mid would estimate
the same quantity far more efficiently and is deliberately not used: calibrating
to the market's prices would erase exactly the disagreement the engine profits
from.

Once measured, the offset corrects the price and the standard deviation joins the
settlement variance in quadrature — the basis is a fresh draw each interval, not
a fixed unknown, so it belongs in the variance rather than in the standard error.
The Monte Carlo draws it per path for the same reason. `MODEL_ERROR_FLOOR` then
drops to `MEASURED_BASIS_ERROR_FLOOR`, since it no longer has to stand in for a
basis that is now priced explicitly.

The fit is powered only by intervals that settled *near* the strike; a window
ending $400 from it was never in doubt and says nothing about a basis worth a few
dollars. That is why the sample gate is so much higher than for the other two
learners, and why it self-adjusts: a small basis produces few near-strike
intervals and waits longer, which is harmless because a small basis barely moves
a probability. Simulated at a $300 window standard deviation, 500 intervals
(about five days at 96 windows a day) pins a $20 basis to roughly ±25%, while a
$5 basis needs around 2000.

`npm run report:daily` prints the current estimate, or says plainly that
`MODEL_ERROR_FLOOR` is still standing in for it.

> Binance is deliberately **not** used as a second opinion here. It is not a BRTI
> constituent — the index is built from Bitstamp, Coinbase, Gemini, Kraken, LMAX
> Digital, Bullish and Crypto.com — its BTCUSDT pair is quoted in USDT rather
> than USD, and it geo-blocks US IPs. Additional venues should come from the
> constituent list.

Refitting happens at startup and after every settlement. Fitted parameters live in the `model_params` table with their fit metrics, and each prediction records which parameter set produced it (`model_params_id`), so generations can be compared. With no or insufficient history the engine uses fixed defaults.

## Notes

- Settlement uses the CF Benchmarks BRTI 60-second average, not our spot feed's last trade. That gap is covered by `MODEL_ERROR_FLOOR` until enough intervals settle to measure it, then priced explicitly.
- Recommendations use executable Kalshi asks plus taker fees and slippage.
- Real order placement is intentionally disabled; paper trading only.
