/**
 * Measures the basis between our spot feed and the CF Benchmarks BRTI average
 * that actually settles KXBTC15M.
 *
 * Kalshi's API returns only the binary result, never the numeric BRTI value, so
 * the basis cannot be differenced directly. It can still be recovered from the
 * settled outcomes: if our own 60-second average `ourAverage` differs from the
 * settling BRTI average by `epsilon ~ Normal(offset, stdDev^2)`, then
 *
 *   P(settles HIGH) = P(ourAverage + epsilon > strike)
 *                   = Phi((distance + offset) / stdDev)
 *
 * where `distance = ourAverage - strike`. Fitting that two-parameter probit to
 * the observed outcomes recovers both a systematic offset (our venue trading
 * persistently rich or cheap to the index) and the interval-to-interval noise.
 *
 * The market's own mid would estimate the same quantity far more efficiently,
 * and is deliberately not used: calibrating to the market's prices would erase
 * exactly the disagreement the engine profits from.
 *
 * No I/O here; `AdaptiveModelService` supplies the samples.
 */
import { normalCdf } from "./baseline-probability.js";

export interface SettlementBasis {
  /**
   * Systematic basis in dollars, signed so that
   * `BRTI average ≈ our average + offset`. Corrected in the price input rather
   * than treated as noise.
   */
  offset: number;
  /** Interval-to-interval standard deviation of the basis, in dollars. */
  stdDev: number;
}

export interface SettlementBasisSample {
  /** Our own settlement-average estimate minus the strike, in dollars. */
  distance: number;
  /** 1 if the interval settled HIGH (yes), 0 if LOW. */
  outcome: number;
}

export interface SettlementBasisFit extends SettlementBasis {
  sampleCount: number;
  /**
   * Samples whose outcome was genuinely in doubt. A settlement 40 standard
   * deviations from the strike is certain either way and says nothing about the
   * basis, so this — not the raw count — is what the fit is powered by.
   */
  informativeCount: number;
  /** Held-out log loss of the fitted basis. */
  validationLogLoss: number;
  /** Held-out log loss of the fallback assumption it must beat. */
  baselineLogLoss: number;
}

/** Widest systematic offset worth entertaining, in dollars. */
const MAX_OFFSET = 200;
/** Basis noise is bounded well away from zero; a perfect proxy is not credible. */
const MIN_STD_DEV = 0.5;
const MAX_STD_DEV = 500;

/** A sample informs the fit only while its outcome is still uncertain. */
const INFORMATIVE_Z = 3;

const LOG_LOSS_EPSILON = 1e-6;

export interface SettlementBasisFitOptions {
  /** Minimum settled intervals before a fit is attempted at all. */
  minSamples?: number;
  /** Minimum near-the-strike intervals, which are what actually carry signal. */
  minInformativeSamples?: number;
  /** Fraction used for fitting; the remainder validates. Samples run oldest first. */
  trainFraction?: number;
  /**
   * Basis standard deviation assumed when nothing is fitted. The candidate must
   * beat this on held-out log loss to be promoted.
   */
  fallbackStdDev?: number;
}

/** P(settles HIGH) implied by a basis, for a given distance to the strike. */
export function basisHighProbability(
  distance: number,
  basis: SettlementBasis,
): number {
  if (basis.stdDev <= 0) return distance > 0 ? 1 : 0;
  return normalCdf((distance + basis.offset) / basis.stdDev);
}

export function meanLogLoss(
  pairs: Array<{ probability: number; outcome: number }>,
): number {
  if (pairs.length === 0) return Number.NaN;
  let sum = 0;
  for (const pair of pairs) {
    const p = clamp(pair.probability, LOG_LOSS_EPSILON, 1 - LOG_LOSS_EPSILON);
    sum += pair.outcome >= 0.5 ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / pairs.length;
}

/**
 * Count samples whose outcome was still in doubt under a given basis. Intervals
 * that settled far from the strike are unanimous regardless of the basis and
 * carry no information about it.
 */
export function countInformativeSamples(
  samples: SettlementBasisSample[],
  basis: SettlementBasis,
): number {
  if (basis.stdDev <= 0) return 0;
  let count = 0;
  for (const sample of samples) {
    if (
      Math.abs((sample.distance + basis.offset) / basis.stdDev) < INFORMATIVE_Z
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Maximum-likelihood basis, fit by coarse grid search followed by coordinate
 * refinement. The likelihood is flat and often bimodal when few intervals land
 * near the strike, so a grid start is used instead of gradient descent from an
 * arbitrary point.
 */
export function maximizeBasisLikelihood(
  samples: SettlementBasisSample[],
): SettlementBasis | null {
  if (samples.length === 0) return null;

  let best: SettlementBasis | null = null;
  let bestLogLikelihood = -Infinity;

  const offsetSteps = 41;
  const stdDevSteps = 41;
  for (let i = 0; i < offsetSteps; i += 1) {
    const offset = -MAX_OFFSET + (2 * MAX_OFFSET * i) / (offsetSteps - 1);
    for (let j = 0; j < stdDevSteps; j += 1) {
      // Log-spaced: the plausible range spans three orders of magnitude.
      const stdDev =
        MIN_STD_DEV *
        (MAX_STD_DEV / MIN_STD_DEV) ** (j / (stdDevSteps - 1));
      const logLikelihood = basisLogLikelihood(samples, { offset, stdDev });
      if (logLikelihood > bestLogLikelihood) {
        bestLogLikelihood = logLikelihood;
        best = { offset, stdDev };
      }
    }
  }

  if (!best) return null;

  let current = best;
  let offsetStep = (2 * MAX_OFFSET) / (offsetSteps - 1);
  let stdDevFactor = (MAX_STD_DEV / MIN_STD_DEV) ** (1 / (stdDevSteps - 1));

  for (let round = 0; round < 60; round += 1) {
    const candidates: SettlementBasis[] = [
      { offset: current.offset + offsetStep, stdDev: current.stdDev },
      { offset: current.offset - offsetStep, stdDev: current.stdDev },
      { offset: current.offset, stdDev: current.stdDev * stdDevFactor },
      { offset: current.offset, stdDev: current.stdDev / stdDevFactor },
    ];

    let improved = false;
    for (const candidate of candidates) {
      const clamped = clampBasis(candidate);
      const logLikelihood = basisLogLikelihood(samples, clamped);
      if (logLikelihood > bestLogLikelihood + 1e-12) {
        bestLogLikelihood = logLikelihood;
        current = clamped;
        improved = true;
      }
    }

    if (!improved) {
      offsetStep /= 2;
      stdDevFactor = Math.sqrt(stdDevFactor);
      if (offsetStep < 1e-3 && stdDevFactor - 1 < 1e-6) break;
    }
  }

  return current;
}

/**
 * Fit the basis and promote it only when it beats the fallback assumption on
 * held-out intervals, mirroring how the Platt calibration is gated. Samples
 * must run oldest to newest.
 */
export function fitSettlementBasis(
  samples: SettlementBasisSample[],
  options: SettlementBasisFitOptions = {},
): SettlementBasisFit | null {
  const minSamples = options.minSamples ?? 500;
  const minInformativeSamples = options.minInformativeSamples ?? 75;
  const trainFraction = options.trainFraction ?? 0.8;
  const fallbackStdDev = options.fallbackStdDev ?? 25;

  const usable = samples.filter(
    (sample) => Number.isFinite(sample.distance) && Number.isFinite(sample.outcome),
  );
  if (usable.length < minSamples) return null;

  const splitIndex = Math.floor(usable.length * trainFraction);
  const train = usable.slice(0, splitIndex);
  const validation = usable.slice(splitIndex);
  if (train.length === 0 || validation.length === 0) return null;

  const candidate = maximizeBasisLikelihood(train);
  if (!candidate) return null;

  const fallback: SettlementBasis = { offset: 0, stdDev: fallbackStdDev };
  const validationLogLoss = meanLogLoss(
    validation.map((sample) => ({
      probability: basisHighProbability(sample.distance, candidate),
      outcome: sample.outcome,
    })),
  );
  const baselineLogLoss = meanLogLoss(
    validation.map((sample) => ({
      probability: basisHighProbability(sample.distance, fallback),
      outcome: sample.outcome,
    })),
  );

  if (!(validationLogLoss <= baselineLogLoss)) return null;

  // Refit on everything once the shape has proven itself out of sample.
  const refit = maximizeBasisLikelihood(usable) ?? candidate;
  const informativeCount = countInformativeSamples(usable, refit);
  if (informativeCount < minInformativeSamples) return null;

  return {
    ...refit,
    sampleCount: usable.length,
    informativeCount,
    validationLogLoss,
    baselineLogLoss,
  };
}

function basisLogLikelihood(
  samples: SettlementBasisSample[],
  basis: SettlementBasis,
): number {
  let total = 0;
  for (const sample of samples) {
    const p = clamp(
      basisHighProbability(sample.distance, basis),
      LOG_LOSS_EPSILON,
      1 - LOG_LOSS_EPSILON,
    );
    total += sample.outcome >= 0.5 ? Math.log(p) : Math.log(1 - p);
  }
  return total;
}

function clampBasis(basis: SettlementBasis): SettlementBasis {
  return {
    offset: clamp(basis.offset, -MAX_OFFSET, MAX_OFFSET),
    stdDev: clamp(basis.stdDev, MIN_STD_DEV, MAX_STD_DEV),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
