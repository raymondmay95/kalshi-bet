import {
  calculateBaselineProbability,
  normalCdf,
  type ProbabilityInput,
  type ProbabilityOptions,
} from "./baseline-probability.js";

/**
 * How wrong the realized-volatility estimate typically is, as a fraction of
 * itself. Short-window realized vol on BTC is a noisy estimator; 30% is a
 * conservative-but-not-absurd standard error for 1-15 minute windows.
 */
export const DEFAULT_VOL_RELATIVE_ERROR = 0.3;

/**
 * Momentum is a weak predictor, so treat most of the drift adjustment as
 * uncertain rather than as known signal.
 */
export const DEFAULT_DRIFT_UNCERTAINTY_SHARE = 0.7;

/**
 * Irreducible error floor covering model misspecification: normal-tail
 * approximation, and the basis between our spot feed and the CF Benchmarks
 * BRTI average that actually settles the market.
 */
export const DEFAULT_MODEL_ERROR_FLOOR = 0.02;

const MIN_STD_ERROR = 0.005;
const MAX_STD_ERROR = 0.25;

export interface ProbabilityUncertaintyInput extends ProbabilityInput {
  /** Point estimate actually being traded on (Monte Carlo result if present). */
  pointEstimate: number;
  /** Path count behind `pointEstimate`, when it came from Monte Carlo. */
  monteCarloPathCount?: number | null;
  volRelativeError?: number;
  driftUncertaintyShare?: number;
  modelErrorFloor?: number;
}

export interface ProbabilityUncertainty {
  /** Standard error of P(HIGH), combining all sources below. */
  standardError: number;
  /** Contribution from mis-estimated volatility. */
  volatilityComponent: number;
  /** Contribution from an unreliable drift/momentum estimate. */
  driftComponent: number;
  /** Monte Carlo sampling error, zero when the analytical model is used. */
  samplingComponent: number;
  /** Model-misspecification floor. */
  modelComponent: number;
}

/**
 * Estimate the standard error of P(HIGH) by re-evaluating the model at
 * perturbed parameters, rather than asserting a confidence number. Each
 * component is the probability swing caused by one plausible parameter error;
 * they are combined in quadrature as independent sources.
 */
export function estimateProbabilityUncertainty(
  input: ProbabilityUncertaintyInput,
  options: ProbabilityOptions = {},
): ProbabilityUncertainty {
  const volError = input.volRelativeError ?? DEFAULT_VOL_RELATIVE_ERROR;
  const driftShare =
    input.driftUncertaintyShare ?? DEFAULT_DRIFT_UNCERTAINTY_SHARE;
  const modelFloor = input.modelErrorFloor ?? DEFAULT_MODEL_ERROR_FLOOR;

  const probabilityAt = (overrides: Partial<ProbabilityInput>): number =>
    calculateBaselineProbability({ ...input, ...overrides }, options)
      .adjustedHighProbability;

  const volUp = probabilityAt({
    volatilityPerSqrtSecond: input.volatilityPerSqrtSecond * (1 + volError),
  });
  const volDown = probabilityAt({
    volatilityPerSqrtSecond: input.volatilityPerSqrtSecond * (1 - volError),
  });
  const volatilityComponent = Math.abs(volUp - volDown) / 2;

  const withDrift = probabilityAt({});
  const withoutDrift = probabilityAt({ driftPerSecond: 0 });
  const driftComponent = Math.abs(withDrift - withoutDrift) * driftShare;

  const pathCount = input.monteCarloPathCount ?? 0;
  const samplingComponent =
    pathCount > 0
      ? Math.sqrt(
          (input.pointEstimate * (1 - input.pointEstimate)) / pathCount,
        )
      : 0;

  const standardError = clamp(
    Math.hypot(
      volatilityComponent,
      driftComponent,
      samplingComponent,
      modelFloor,
    ),
    MIN_STD_ERROR,
    MAX_STD_ERROR,
  );

  return {
    standardError,
    volatilityComponent,
    driftComponent,
    samplingComponent,
    modelComponent: modelFloor,
  };
}

/**
 * Probability that a bet with the given edge is genuinely positive-EV, given
 * how uncertain our probability estimate is. This is the number worth calling
 * "certainty": it answers "how likely is this bet actually good?" rather than
 * "how far is spot from the strike?".
 */
export function probabilityEdgeIsPositive(
  edge: number,
  standardError: number,
): number {
  if (standardError <= 0) return edge > 0 ? 1 : 0;
  return clamp(normalCdf(edge / standardError), 0, 1);
}

/**
 * Edge discounted for estimation error — a lower confidence bound used for
 * position sizing so that a noisy edge is staked smaller than a clean one.
 */
export function conservativeEdge(
  edge: number,
  standardError: number,
  haircutStdDevs = 0.5,
): number {
  return edge - haircutStdDevs * standardError;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
