import { applyCalibration, type PlattCalibration } from "./calibration.js";

export interface ProbabilityInput {
  currentPrice: number;
  threshold: number;
  secondsRemaining: number;
  /** Dollar volatility per sqrt-second. */
  volatilityPerSqrtSecond: number;
  /** Expected dollar drift per second, from the trend estimator. */
  driftPerSecond?: number;
  minimumVolatility?: number;
}

export interface ProbabilityOptions {
  /** Fixed log-odds shrink used when no fitted calibration is available. */
  confidenceMultiplier?: number;
  /** Calibration learned from settled history; overrides the fixed shrink. */
  calibration?: PlattCalibration | null;
}

export interface ProbabilityOutput {
  rawHighProbability: number;
  adjustedHighProbability: number;
  lowProbability: number;
  zScore: number;
  effectiveSeconds: number;
  remainingStdDev: number;
  /** Dollar drift applied to the z-score (after capping). */
  appliedDrift: number;
  confidence: number;
}

// Relative volatility bounds, expressed as a fraction of price per
// sqrt-second. For BTC, 1e-4 (1 bp/sqrt-s) projects to roughly a 0.3%
// standard deviation over a 15-minute window, in line with typical
// realized volatility.
const VOL_FALLBACK_RELATIVE = 1e-4;
const VOL_FLOOR_RELATIVE = 2e-5;
const VOL_CAP_RELATIVE = 1e-3;

// Never let the trend shift the z-score by more than this many standard
// deviations; momentum is a weak signal and must not dominate diffusion.
const MAX_DRIFT_STDDEVS = 1.5;

// Never claim certainty: BTC returns have fat tails that the normal
// model understates.
export const PROBABILITY_CAP = 0.99;

export const DEFAULT_CONFIDENCE_MULTIPLIER = 0.85;

export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const probability =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - probability : probability;
}

export function effectiveSecondsForSettlement(secondsRemaining: number): number {
  return Math.max(secondsRemaining - 30, 1);
}

/**
 * Combine per-sqrt-second volatility estimates from multiple windows into
 * one estimate (weighted root-mean-square, so variances average linearly).
 */
export function blendVolatilityPerSqrtSecond(
  candidates: Array<{ value: number | null | undefined; weight: number }>,
): number | null {
  let weightSum = 0;
  let varianceSum = 0;
  for (const candidate of candidates) {
    if (candidate.value != null && candidate.value > 0) {
      weightSum += candidate.weight;
      varianceSum += candidate.weight * candidate.value * candidate.value;
    }
  }
  if (weightSum <= 0) return null;
  return Math.sqrt(varianceSum / weightSum);
}

/**
 * Convert relative (log-return) volatility per sqrt-second into dollar
 * volatility per sqrt-second, with price-relative floor, cap, and fallback.
 */
export function estimateVolatilityPerSqrtSecond(
  relativeVolPerSqrtSecond: number | null | undefined,
  price: number,
): number {
  if (price <= 0) return 0;
  const relative =
    relativeVolPerSqrtSecond != null && relativeVolPerSqrtSecond > 0
      ? relativeVolPerSqrtSecond
      : VOL_FALLBACK_RELATIVE;
  return clamp(relative, VOL_FLOOR_RELATIVE, VOL_CAP_RELATIVE) * price;
}

export function calculateBaselineProbability(
  input: ProbabilityInput,
  options: ProbabilityOptions = {},
): ProbabilityOutput {
  const confidenceMultiplier =
    options.confidenceMultiplier ?? DEFAULT_CONFIDENCE_MULTIPLIER;
  const effectiveSeconds = effectiveSecondsForSettlement(input.secondsRemaining);
  const minimumVolatility =
    input.minimumVolatility ??
    Math.max(input.currentPrice * VOL_FLOOR_RELATIVE, 1e-9);
  const remainingStdDev = Math.max(
    input.volatilityPerSqrtSecond * Math.sqrt(effectiveSeconds),
    minimumVolatility,
  );

  const uncappedDrift = (input.driftPerSecond ?? 0) * effectiveSeconds;
  const appliedDrift = clamp(
    uncappedDrift,
    -MAX_DRIFT_STDDEVS * remainingStdDev,
    MAX_DRIFT_STDDEVS * remainingStdDev,
  );

  const zScore =
    remainingStdDev > 0
      ? (input.currentPrice + appliedDrift - input.threshold) / remainingStdDev
      : 0;

  const rawHighProbability = clamp(normalCdf(zScore), 0, 1);
  const calibrated = options.calibration
    ? applyCalibration(rawHighProbability, options.calibration)
    : shrinkTowardHalfInLogOdds(rawHighProbability, confidenceMultiplier);
  const adjustedHighProbability = clamp(
    calibrated,
    1 - PROBABILITY_CAP,
    PROBABILITY_CAP,
  );
  const lowProbability = 1 - adjustedHighProbability;

  const distanceFactor = Math.min(1, Math.abs(zScore) / 3);
  const timeFactor = clamp(1 - effectiveSeconds / 900, 0, 1);
  const confidence = clamp(0.5 + 0.5 * (distanceFactor * 0.7 + timeFactor * 0.3), 0, 1);

  return {
    rawHighProbability,
    adjustedHighProbability,
    lowProbability,
    zScore,
    effectiveSeconds,
    remainingStdDev,
    appliedDrift,
    confidence,
  };
}

/**
 * Shrink a probability toward 0.5 in log-odds space. Behaves far better
 * near 0 and 1 than a linear shrink in probability space, and models
 * "the z-score is systematically overconfident by a constant factor".
 * Equivalent to a Platt calibration with intercept 0.
 */
export function shrinkTowardHalfInLogOdds(
  probability: number,
  multiplier: number,
): number {
  return applyCalibration(probability, { intercept: 0, slope: multiplier });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
