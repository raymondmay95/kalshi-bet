import { getEnv } from "../config/environment.js";
import {
  conservativeEdge,
  probabilityEdgeIsPositive,
} from "../model/probability-uncertainty.js";
import {
  calculateExpectedValue,
  calculateKellyFraction,
  DEFAULT_ASSUMED_ORDER_SIZE,
} from "./fees.js";

/** Directional forecast — always HIGH or LOW. */
export type PredictedDirection = "HIGH" | "LOW";

/** Betting action — independent of the directional forecast. */
export type TradeRecommendation = "BET_HIGH" | "BET_LOW" | "NO_BET";

/** Legacy recommendation field for DB / paper-trade compatibility. */
export type Recommendation = "HIGH" | "LOW" | "NO_BET";

/**
 * How hard the engine is leaning on the trade. Everything except PASS is an
 * actionable bet; the grade drives position size rather than gating the bet,
 * so a thin-but-positive edge still produces a decision.
 */
export type SignalStrength = "STRONG" | "MODERATE" | "LEAN" | "PASS";

/** Why no bet is possible. Execution problems, not opinions about the price. */
export type Blocker =
  | "STALE_DATA"
  | "NO_QUOTES"
  | "CROSSED_BOOK"
  | "NO_LIQUIDITY"
  | "WINDOW_CLOSING"
  | "SPREAD_TOO_WIDE";

export interface DecisionInput {
  highProbability: number;
  /** Standard error of `highProbability`, from the uncertainty model. */
  probabilityStdError: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  yesLiquidity: number;
  noLiquidity: number;
  secondsRemaining: number;
  dataIsStale: boolean;
  distanceToThresholdBps: number;
  tradeImbalance: number;
  momentum30s: number | null;
  momentum3m: number | null;
}

export interface DecisionOutput {
  predictedDirection: PredictedDirection;
  tradeRecommendation: TradeRecommendation;
  recommendation: Recommendation;
  strength: SignalStrength;
  /** P(the forecast direction is right) — the headline certainty number. */
  directionCertainty: number;
  /** P(this bet is genuinely +EV) after accounting for estimation error. */
  edgeCertainty: number;
  highEdge: number;
  lowEdge: number;
  /** Edge on the side actually being recommended. */
  bestEdge: number;
  /** All-in per-contract cost on the recommended side. */
  bestCost: number;
  effectiveYesCost: number;
  effectiveNoCost: number;
  /** Market's own P(HIGH) from the YES/NO midpoints. */
  marketImpliedHigh: number;
  /** Model probability minus market-implied probability, on the HIGH side. */
  modelDisagreement: number;
  /** Fraction of bankroll to stake — 0 when not betting. */
  stakeFraction: number;
  blockers: Blocker[];
  reasons: string[];
  warnings: string[];
}

export interface DecisionConfig {
  /** Edge floor for a LEAN — the smallest edge worth acting on at all. */
  minimumEdge: number;
  moderateEdge: number;
  strongEdge: number;
  /** Minimum P(edge > 0) for each grade. */
  minimumEdgeCertainty: number;
  moderateEdgeCertainty: number;
  strongEdgeCertainty: number;
  maximumSpread: number;
  minimumSecondsRemaining: number;
  minimumLiquidity: number;
  feeCoefficient: number;
  slippage: number;
  assumedOrderSize: number;
  kellyMultiplier: number;
  maximumStakeFraction: number;
  minimumStakeFraction: number;
  /**
   * When true, still always produces a predictedDirection (always does).
   * Must NOT bypass trade-recommendation safety checks.
   */
  alwaysPickSide: boolean;
}

export interface BetRecommendation extends DecisionOutput {
  marketTicker: string;
  timestamp: number;
  threshold: number;
  btcPrice: number;
  secondsRemaining: number;
  highProbability: number;
  lowProbability: number;
  probabilityStdError: number;
  highAsk: number;
  lowAsk: number;
  /** Retained for the DB column; equals `edgeCertainty`. */
  confidence: number;
}

export function getDefaultDecisionConfig(): DecisionConfig {
  const env = getEnv();
  return {
    minimumEdge: env.MINIMUM_EDGE,
    moderateEdge: env.MODERATE_EDGE,
    strongEdge: env.STRONG_EDGE,
    minimumEdgeCertainty: env.MINIMUM_EDGE_CERTAINTY,
    moderateEdgeCertainty: env.MODERATE_EDGE_CERTAINTY,
    strongEdgeCertainty: env.STRONG_EDGE_CERTAINTY,
    maximumSpread: env.MAXIMUM_SPREAD,
    minimumSecondsRemaining: env.MINIMUM_SECONDS_REMAINING,
    minimumLiquidity: env.MINIMUM_LIQUIDITY,
    feeCoefficient: env.TAKER_FEE_COEFFICIENT,
    slippage: env.SLIPPAGE_CENTS,
    assumedOrderSize: env.ASSUMED_ORDER_SIZE,
    kellyMultiplier: env.KELLY_MULTIPLIER,
    maximumStakeFraction: env.MAXIMUM_STAKE_FRACTION,
    minimumStakeFraction: env.MINIMUM_STAKE_FRACTION,
    alwaysPickSide: env.ALWAYS_PICK_SIDE,
  };
}

export function pickDirection(input: {
  highProbability: number;
  highEdge: number;
  lowEdge: number;
}): PredictedDirection {
  if (input.highEdge > input.lowEdge) return "HIGH";
  if (input.lowEdge > input.highEdge) return "LOW";
  return input.highProbability >= 0.5 ? "HIGH" : "LOW";
}

export function tradeToLegacy(trade: TradeRecommendation): Recommendation {
  if (trade === "BET_HIGH") return "HIGH";
  if (trade === "BET_LOW") return "LOW";
  return "NO_BET";
}

/**
 * Market's own P(HIGH). Averages the YES midpoint with the NO midpoint's
 * complement, since the two books should agree and averaging halves the noise.
 */
export function marketImpliedHighProbability(input: {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}): number {
  const yesMid = (input.yesBid + input.yesAsk) / 2;
  const noMid = (input.noBid + input.noAsk) / 2;
  const usable = [yesMid, 1 - noMid].filter((v) => v > 0 && v < 1);
  if (usable.length === 0) return 0.5;
  return usable.reduce((sum, v) => sum + v, 0) / usable.length;
}

/**
 * Grade the trade. Every grade above PASS is an actionable bet; strength scales
 * the stake. A weak signal is a small bet, not a refusal to decide — only the
 * execution blockers in `collectBlockers` can force PASS.
 */
function gradeStrength(
  edge: number,
  edgeCertainty: number,
  config: DecisionConfig,
): SignalStrength {
  if (edge >= config.strongEdge && edgeCertainty >= config.strongEdgeCertainty) {
    return "STRONG";
  }
  if (
    edge >= config.moderateEdge &&
    edgeCertainty >= config.moderateEdgeCertainty
  ) {
    return "MODERATE";
  }
  if (edge >= config.minimumEdge && edgeCertainty >= config.minimumEdgeCertainty) {
    return "LEAN";
  }
  return "PASS";
}

function collectBlockers(
  input: DecisionInput,
  config: DecisionConfig,
  side: PredictedDirection,
): Blocker[] {
  const blockers: Blocker[] = [];

  if (input.dataIsStale) blockers.push("STALE_DATA");

  const ask = side === "HIGH" ? input.yesAsk : input.noAsk;
  const bid = side === "HIGH" ? input.yesBid : input.noBid;
  if (!(ask > 0 && ask < 1)) blockers.push("NO_QUOTES");
  else if (bid > ask) blockers.push("CROSSED_BOOK");

  const liquidity = side === "HIGH" ? input.yesLiquidity : input.noLiquidity;
  if (liquidity < config.minimumLiquidity) blockers.push("NO_LIQUIDITY");

  if (input.secondsRemaining < config.minimumSecondsRemaining) {
    blockers.push("WINDOW_CLOSING");
  }

  const spread = Math.max(0, ask - bid);
  if (spread > config.maximumSpread) blockers.push("SPREAD_TOO_WIDE");

  return blockers;
}

interface SideCandidate {
  side: PredictedDirection;
  edge: number;
  cost: number;
  edgeCertainty: number;
  blockers: Blocker[];
  strength: SignalStrength;
}

const STRENGTH_RANK: Record<SignalStrength, number> = {
  PASS: 0,
  LEAN: 1,
  MODERATE: 2,
  STRONG: 3,
};

/**
 * Both sides are graded independently so a side-specific execution problem
 * (no resting size, missing quote) falls through to the other side instead of
 * killing the whole decision.
 */
function evaluateSide(
  side: PredictedDirection,
  edge: number,
  cost: number,
  input: DecisionInput,
  config: DecisionConfig,
): SideCandidate {
  const blockers = collectBlockers(input, config, side);
  const edgeCertainty = probabilityEdgeIsPositive(
    edge,
    input.probabilityStdError,
  );
  return {
    side,
    edge,
    cost,
    edgeCertainty,
    blockers,
    strength:
      blockers.length > 0 ? "PASS" : gradeStrength(edge, edgeCertainty, config),
  };
}

function preferCandidate(a: SideCandidate, b: SideCandidate): SideCandidate {
  const rankDelta = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
  if (rankDelta !== 0) return rankDelta > 0 ? a : b;
  return a.edge >= b.edge ? a : b;
}

const BLOCKER_TEXT: Record<Blocker, string> = {
  STALE_DATA: "Price or market data is stale — cannot price the bet right now",
  NO_QUOTES: "No usable quote on the recommended side",
  CROSSED_BOOK: "Order book is crossed — quotes are unreliable",
  NO_LIQUIDITY: "Not enough resting size to fill on the recommended side",
  WINDOW_CLOSING: "Too little time left to get filled",
  SPREAD_TOO_WIDE: "Spread is too wide to cross",
};

export function makeDecision(
  input: DecisionInput,
  config: DecisionConfig = getDefaultDecisionConfig(),
): DecisionOutput {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const ev = calculateExpectedValue({
    highProbability: input.highProbability,
    yesAsk: input.yesAsk,
    noAsk: input.noAsk,
    feeCoefficient: config.feeCoefficient,
    slippage: config.slippage,
    assumedOrderSize: config.assumedOrderSize,
  });

  const predictedDirection = pickDirection({
    highProbability: input.highProbability,
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
  });

  const directionCertainty =
    predictedDirection === "HIGH"
      ? input.highProbability
      : 1 - input.highProbability;

  const best = preferCandidate(
    evaluateSide("HIGH", ev.highEdge, ev.effectiveYesCost, input, config),
    evaluateSide("LOW", ev.lowEdge, ev.effectiveNoCost, input, config),
  );
  const {
    side: bestSide,
    edge: bestEdge,
    cost: bestCost,
    edgeCertainty,
    blockers,
    strength,
  } = best;

  const marketImpliedHigh = marketImpliedHighProbability(input);
  const modelDisagreement = input.highProbability - marketImpliedHigh;

  reasons.push(
    `Model puts ${predictedDirection} at ${(directionCertainty * 100).toFixed(1)}%, market at ${(
      (predictedDirection === "HIGH"
        ? marketImpliedHigh
        : 1 - marketImpliedHigh) * 100
    ).toFixed(1)}%`,
  );
  appendMarketReasons(input, reasons);

  for (const blocker of blockers) warnings.push(BLOCKER_TEXT[blocker]);

  if (blockers.length === 0) {
    if (strength === "PASS") {
      reasons.push(
        bestEdge <= 0
          ? `Market is priced at or above our estimate — best edge is ${formatEdge(bestEdge)} after costs`
          : `Edge of ${formatEdge(bestEdge)} is too thin or too uncertain to stake (${(edgeCertainty * 100).toFixed(0)}% chance it is real)`,
      );
    } else {
      reasons.push(
        `${bestSide} is ${formatEdge(bestEdge)} cheap after fees and slippage, ${(edgeCertainty * 100).toFixed(0)}% likely to be a real edge`,
      );
    }
  }

  const tradeRecommendation: TradeRecommendation =
    strength === "PASS" ? "NO_BET" : bestSide === "HIGH" ? "BET_HIGH" : "BET_LOW";

  // A recommended bet always carries a usable size. Kelly on the
  // uncertainty-discounted edge can round to zero on a noisy estimate, which
  // would leave an actionable signal with no executable stake.
  const stakeFraction =
    strength === "PASS"
      ? 0
      : Math.max(
          config.minimumStakeFraction,
          calculateKellyFraction(
            conservativeEdge(bestEdge, input.probabilityStdError),
            bestCost,
            config.kellyMultiplier,
            config.maximumStakeFraction,
          ),
        );

  if (config.alwaysPickSide && tradeRecommendation === "NO_BET") {
    reasons.push(
      `If forced to pick a side: ${predictedDirection} at ${(directionCertainty * 100).toFixed(1)}% certainty`,
    );
  }

  return {
    predictedDirection,
    tradeRecommendation,
    recommendation: tradeToLegacy(tradeRecommendation),
    strength,
    directionCertainty,
    edgeCertainty,
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
    bestEdge,
    bestCost,
    effectiveYesCost: ev.effectiveYesCost,
    effectiveNoCost: ev.effectiveNoCost,
    marketImpliedHigh,
    modelDisagreement,
    stakeFraction,
    blockers,
    reasons,
    warnings,
  };
}

function formatEdge(edge: number): string {
  return `${edge >= 0 ? "" : "-"}${Math.abs(edge * 100).toFixed(1)}c`;
}

function appendMarketReasons(input: DecisionInput, reasons: string[]): void {
  if (Math.abs(input.distanceToThresholdBps) >= 1) {
    reasons.push(
      `Bitcoin is ${Math.abs(input.distanceToThresholdBps).toFixed(1)} basis points ${input.distanceToThresholdBps >= 0 ? "above" : "below"} the strike`,
    );
  }

  if (input.momentum30s != null && input.momentum30s !== 0) {
    reasons.push(
      `Thirty-second momentum is ${input.momentum30s > 0 ? "positive" : "negative"}`,
    );
  }

  if (input.momentum3m != null && input.momentum3m !== 0) {
    reasons.push(
      `Three-minute momentum is ${input.momentum3m > 0 ? "positive" : "negative"}`,
    );
  }

  if (input.tradeImbalance > 0.1) {
    reasons.push("Aggressive trade flow favors buyers");
  } else if (input.tradeImbalance < -0.1) {
    reasons.push("Aggressive trade flow favors sellers");
  }
}

export function buildBetRecommendation(input: {
  marketTicker: string;
  timestamp: number;
  threshold: number;
  btcPrice: number;
  secondsRemaining: number;
  highProbability: number;
  probabilityStdError: number;
  yesAsk: number;
  noAsk: number;
  decision: DecisionOutput;
}): BetRecommendation {
  return {
    ...input.decision,
    marketTicker: input.marketTicker,
    timestamp: input.timestamp,
    threshold: input.threshold,
    btcPrice: input.btcPrice,
    secondsRemaining: input.secondsRemaining,
    highProbability: input.highProbability,
    lowProbability: 1 - input.highProbability,
    probabilityStdError: input.probabilityStdError,
    highAsk: input.yesAsk,
    lowAsk: input.noAsk,
    confidence: input.decision.edgeCertainty,
  };
}

export { DEFAULT_ASSUMED_ORDER_SIZE };
