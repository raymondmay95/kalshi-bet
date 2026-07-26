/**
 * Settlement-aware Monte Carlo for Kalshi BTC 15m HIGH/LOW markets.
 *
 * Models the CF Benchmarks BRTI-style 60-second settlement average rather
 * than only the terminal spot price. Uses typed arrays and avoids object
 * allocation in the inner loop.
 */

export type ShockDistribution = "normal" | "student-t";

export interface MonteCarloInput {
  currentPrice: number;
  strike: number;
  secondsRemaining: number;
  /** Dollar volatility per sqrt-second. */
  volatility: number;
  /** Dollar drift per second. */
  drift: number;
  settlementWindowSeconds: number;
  /**
   * Prices already observed inside the settlement window (oldest → newest).
   * Used when secondsRemaining < settlementWindowSeconds.
   */
  observedSettlementPrices?: Float64Array | number[];
  pathCount: number;
  seed?: number;
  shockDistribution?: ShockDistribution;
  studentTDegreesOfFreedom?: number;
  /** Simulation step size inside the settlement window (seconds). */
  stepSeconds?: number;
}

export interface MonteCarloResult {
  highProbability: number;
  lowProbability: number;
  estimatedSettlementAverage: number;
  pathCount: number;
  durationMs: number;
  seed: number;
  modelVersion: string;
}

export const MONTE_CARLO_MODEL_VERSION = "settlement-avg-mc@1.0.0";

/** Mulberry32 — fast deterministic PRNG. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Approximate chi-square(df) via sum of squared normals, then Student-t. */
function studentT(rng: () => number, df: number): number {
  const z = boxMuller(rng);
  let chi = 0;
  for (let i = 0; i < df; i += 1) {
    const g = boxMuller(rng);
    chi += g * g;
  }
  return z / Math.sqrt(chi / df);
}

function sampleShock(
  rng: () => number,
  distribution: ShockDistribution,
  df: number,
): number {
  if (distribution === "student-t") {
    return studentT(rng, df);
  }
  return boxMuller(rng);
}

function clampProbability(p: number): number {
  return Math.max(0, Math.min(1, p));
}

/**
 * Run settlement-average Monte Carlo.
 *
 * Algorithm:
 * 1. Jump from now to settlement-window start with one Brownian step
 *    (or stay if already inside the window).
 * 2. Walk the remaining settlement window in `stepSeconds` increments.
 * 3. Settlement = average of (observed prices + simulated window prices)
 *    normalized to the full settlement window length.
 */
export function runSettlementMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const started = performance.now();
  const pathCount = Math.max(1, Math.floor(input.pathCount));
  const seed = input.seed ?? 1;
  const rng = createRng(seed);
  const windowSeconds = Math.max(1, input.settlementWindowSeconds);
  const stepSeconds = Math.max(1, Math.floor(input.stepSeconds ?? 1));
  const secondsRemaining = Math.max(0, input.secondsRemaining);
  const vol = Math.max(0, input.volatility);
  const drift = input.drift;
  const distribution = input.shockDistribution ?? "student-t";
  const df = Math.max(2, Math.floor(input.studentTDegreesOfFreedom ?? 5));

  const observed = toFloat64(input.observedSettlementPrices);
  const observedCount = observed.length;
  const observedSum = sumFloat64(observed);

  // How much of the settlement window is still in the future.
  const remainingInWindow = Math.min(windowSeconds, secondsRemaining);
  // Time until the settlement window opens (0 if already inside).
  const timeToWindowStart = Math.max(0, secondsRemaining - windowSeconds);

  // Observed portion fills the leading part of the window when we are inside it.
  const expectedObserved = Math.max(0, windowSeconds - secondsRemaining);
  // Weight observed samples evenly across the already-elapsed window seconds.
  const observedWeight =
    observedCount > 0 ? Math.min(expectedObserved, windowSeconds) : 0;

  let highCount = 0;
  let settlementSum = 0;

  for (let p = 0; p < pathCount; p += 1) {
    let price = input.currentPrice;

    // Jump to settlement-window start (single step).
    if (timeToWindowStart > 0 && price > 0) {
      const shock = sampleShock(rng, distribution, df);
      const dt = timeToWindowStart;
      price =
        price +
        drift * dt +
        vol * Math.sqrt(dt) * shock;
      if (price < 1) price = 1;
    }

    // Simulate remaining settlement-window seconds.
    let simulatedSum = 0;
    let simulatedWeight = 0;
    let tLeft = remainingInWindow;
    while (tLeft > 0) {
      const dt = Math.min(stepSeconds, tLeft);
      const shock = sampleShock(rng, distribution, df);
      price = price + drift * dt + vol * Math.sqrt(dt) * shock;
      if (price < 1) price = 1;
      simulatedSum += price * dt;
      simulatedWeight += dt;
      tLeft -= dt;
    }

    // Combine observed and simulated into a window-length average.
    let totalWeight = observedWeight + simulatedWeight;
    let totalSum =
      (observedCount > 0 && observedWeight > 0
        ? (observedSum / observedCount) * observedWeight
        : 0) + simulatedSum;

    // If we somehow have no samples (pathological), fall back to spot.
    if (totalWeight <= 0) {
      totalWeight = 1;
      totalSum = price;
    }

    // Pad to full window if both observed and simulated undershoot
    // (e.g. missing observations): use last price for remainder.
    if (totalWeight < windowSeconds) {
      const pad = windowSeconds - totalWeight;
      totalSum += price * pad;
      totalWeight = windowSeconds;
    }

    const settlementAverage = totalSum / totalWeight;
    settlementSum += settlementAverage;
    if (settlementAverage >= input.strike) {
      highCount += 1;
    }
  }

  const highProbability = clampProbability(highCount / pathCount);
  const durationMs = performance.now() - started;

  return {
    highProbability,
    lowProbability: 1 - highProbability,
    estimatedSettlementAverage: settlementSum / pathCount,
    pathCount,
    durationMs,
    seed,
    modelVersion: MONTE_CARLO_MODEL_VERSION,
  };
}

function toFloat64(values?: Float64Array | number[]): Float64Array {
  if (!values || values.length === 0) return new Float64Array(0);
  if (values instanceof Float64Array) return values;
  return Float64Array.from(values);
}

function sumFloat64(values: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
  }
  return sum;
}
