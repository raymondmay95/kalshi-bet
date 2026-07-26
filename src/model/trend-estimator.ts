/**
 * Estimates a short-horizon price drift (trend) from Binance market data:
 * multi-window momentum from trade prints, aggressive trade-flow imbalance,
 * and order-book depth imbalance.
 *
 * The output is a conservative dollars-per-second drift that shifts the
 * center of the settlement distribution in the probability model. All
 * coefficients are deliberately damped: momentum only partially persists,
 * and the probability model additionally caps the total drift contribution
 * relative to remaining volatility.
 */

export interface TrendInput {
  price: number;
  /** Log returns in bps keyed as `return_${windowMs}ms_bps`. */
  returnsBps: Record<string, number | null>;
  /** Signed aggressive trade-flow imbalance in [-1, 1]. */
  tradeImbalance: number;
  /** Signed order-book depth imbalance in [-1, 1]. */
  bookImbalance: number;
}

export interface TrendEstimate {
  driftDollarsPerSecond: number;
  driftBpsPerSecond: number;
  momentumBpsPerSecond: number;
  flowBpsPerSecond: number;
}

// Sub-minute windows are dominated by bid-ask bounce, so momentum starts
// at one minute. Shorter windows get more weight (more recent information).
const MOMENTUM_WINDOWS: Array<{ windowMs: number; weight: number }> = [
  { windowMs: 60_000, weight: 0.5 },
  { windowMs: 180_000, weight: 0.3 },
  { windowMs: 300_000, weight: 0.2 },
];

// Fraction of the observed momentum assumed to persist going forward.
const MOMENTUM_PERSISTENCE = 0.3;

// Flow tilt in bps/second at full imbalance. At the extreme, trade flow
// contributes ~18 bps over a full 15-minute window and the book half that.
const TRADE_IMBALANCE_BPS_PER_SECOND = 0.02;
const BOOK_IMBALANCE_BPS_PER_SECOND = 0.01;

export function estimateTrend(input: TrendInput): TrendEstimate {
  let weightSum = 0;
  let weightedRateSum = 0;

  for (const { windowMs, weight } of MOMENTUM_WINDOWS) {
    const returnBps = input.returnsBps[`return_${windowMs}ms_bps`];
    if (returnBps == null || !Number.isFinite(returnBps)) continue;
    const bpsPerSecond = returnBps / (windowMs / 1000);
    weightSum += weight;
    weightedRateSum += weight * bpsPerSecond;
  }

  const momentumBpsPerSecond =
    weightSum > 0
      ? MOMENTUM_PERSISTENCE * (weightedRateSum / weightSum)
      : 0;

  const flowBpsPerSecond =
    TRADE_IMBALANCE_BPS_PER_SECOND * clamp(input.tradeImbalance, -1, 1) +
    BOOK_IMBALANCE_BPS_PER_SECOND * clamp(input.bookImbalance, -1, 1);

  const driftBpsPerSecond = momentumBpsPerSecond + flowBpsPerSecond;
  const driftDollarsPerSecond =
    input.price > 0 ? (driftBpsPerSecond / 10_000) * input.price : 0;

  return {
    driftDollarsPerSecond,
    driftBpsPerSecond,
    momentumBpsPerSecond,
    flowBpsPerSecond,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
