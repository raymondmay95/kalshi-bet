/**
 * Pure fitting math for learning from settled prediction history.
 *
 * - Platt calibration: logistic regression of outcome on logit(raw
 *   probability), learning how overconfident/biased the z-score model is.
 * - Volatility scale: how much the model under/over-estimates realized
 *   moves, as a std-dev multiplier.
 *
 * No I/O here; the AdaptiveModelService feeds these from the database.
 */

export interface PlattCalibration {
  intercept: number;
  slope: number;
}

export interface CalibrationSample {
  rawProbability: number;
  /** 1 if the market settled HIGH, 0 if LOW. */
  outcome: number;
}

export interface VolScaleSample {
  predictedStdDev: number;
  /** Realized dollar move from lock to settlement, minus applied drift. */
  realizedMove: number;
}

const LOGIT_EPSILON = 1e-6;

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function logit(p: number): number {
  const clamped = clamp(p, LOGIT_EPSILON, 1 - LOGIT_EPSILON);
  return Math.log(clamped / (1 - clamped));
}

export function applyCalibration(
  rawProbability: number,
  calibration: PlattCalibration,
): number {
  return sigmoid(
    calibration.intercept + calibration.slope * logit(rawProbability),
  );
}

export interface PlattFitOptions {
  minSamples?: number;
  iterations?: number;
  learningRate?: number;
  /** L2 penalty pulling intercept toward 0 and slope toward 1. */
  l2?: number;
}

/**
 * Fit Platt calibration by gradient descent on mean log-loss with a small
 * L2 penalty toward the identity calibration (intercept 0, slope 1).
 * Returns null when there are not enough samples to fit safely.
 */
export function fitPlattCalibration(
  samples: CalibrationSample[],
  options: PlattFitOptions = {},
): PlattCalibration | null {
  const minSamples = options.minSamples ?? 100;
  if (samples.length < minSamples) return null;

  const iterations = options.iterations ?? 3000;
  const learningRate = options.learningRate ?? 0.1;
  const l2 = options.l2 ?? 0.01;

  const xs = samples.map((s) => logit(s.rawProbability));
  const ys = samples.map((s) => (s.outcome >= 0.5 ? 1 : 0));
  const n = samples.length;

  let intercept = 0;
  let slope = 1;

  for (let iter = 0; iter < iterations; iter += 1) {
    let gradIntercept = 0;
    let gradSlope = 0;
    for (let i = 0; i < n; i += 1) {
      const error = sigmoid(intercept + slope * xs[i]!) - ys[i]!;
      gradIntercept += error;
      gradSlope += error * xs[i]!;
    }
    gradIntercept = gradIntercept / n + 2 * l2 * intercept;
    gradSlope = gradSlope / n + 2 * l2 * (slope - 1);

    intercept -= learningRate * gradIntercept;
    slope -= learningRate * gradSlope;
  }

  return {
    intercept: clamp(intercept, -1.5, 1.5),
    slope: clamp(slope, 0.1, 2),
  };
}

export function meanBrierScore(
  pairs: Array<{ probability: number; outcome: number }>,
): number {
  if (pairs.length === 0) return Number.NaN;
  const sum = pairs.reduce(
    (acc, pair) => acc + (pair.probability - pair.outcome) ** 2,
    0,
  );
  return sum / pairs.length;
}

export interface VolScaleFitOptions {
  minSamples?: number;
  /** Exponential decay applied per sample of age (newest weighs most). */
  decay?: number;
  minScale?: number;
  maxScale?: number;
}

/**
 * Learn a std-dev multiplier from realized moves. If the model's predicted
 * standard deviation were perfect, E[(move/std)^2] = 1; the fitted scale is
 * sqrt of the (recency-weighted) mean squared normalized move, clamped.
 * Samples must be ordered oldest to newest.
 */
export function fitVolScale(
  samples: VolScaleSample[],
  options: VolScaleFitOptions = {},
): number | null {
  const minSamples = options.minSamples ?? 30;
  const decay = options.decay ?? 0.99;
  const minScale = options.minScale ?? 0.5;
  const maxScale = options.maxScale ?? 2;

  const usable = samples.filter((s) => s.predictedStdDev > 0);
  if (usable.length < minSamples) return null;

  let weightSum = 0;
  let weightedZSquaredSum = 0;
  for (let i = 0; i < usable.length; i += 1) {
    const ageFromNewest = usable.length - 1 - i;
    const weight = decay ** ageFromNewest;
    const z = usable[i]!.realizedMove / usable[i]!.predictedStdDev;
    weightSum += weight;
    weightedZSquaredSum += weight * z * z;
  }

  if (weightSum <= 0) return null;
  return clamp(Math.sqrt(weightedZSquaredSum / weightSum), minScale, maxScale);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
