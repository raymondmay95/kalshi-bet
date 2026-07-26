import { getEnv } from "../config/environment.js";
import { calculateExpectedValue } from "./fees.js";

/** Directional forecast — always HIGH or LOW. */
export type PredictedDirection = "HIGH" | "LOW";

/** Betting action — independent of the directional forecast. */
export type TradeRecommendation = "BET_HIGH" | "BET_LOW" | "NO_BET";

/** Legacy recommendation field for DB / paper-trade compatibility. */
export type Recommendation = "HIGH" | "LOW" | "NO_BET";

export interface DecisionInput {
  highProbability: number;
  confidence: number;
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

export interface BetRecommendation {
  marketTicker: string;
  timestamp: number;
  threshold: number;
  btcPrice: number;
  secondsRemaining: number;
  predictedDirection: PredictedDirection;
  tradeRecommendation: TradeRecommendation;
  /** Legacy: HIGH/LOW/NO_BET mapped from tradeRecommendation. */
  recommendation: Recommendation;
  highProbability: number;
  lowProbability: number;
  highAsk: number;
  lowAsk: number;
  highEdge: number;
  lowEdge: number;
  confidence: number;
  reasons: string[];
  warnings: string[];
}

export interface DecisionConfig {
  minimumEdge: number;
  minimumConfidence: number;
  maximumSpread: number;
  minimumSecondsRemaining: number;
  minimumLiquidity: number;
  feeCoefficient: number;
  slippage: number;
  /**
   * When true, still always produces a predictedDirection (always does).
   * Must NOT bypass trade-recommendation safety checks.
   */
  alwaysPickSide: boolean;
}

export function getDefaultDecisionConfig(): DecisionConfig {
  const env = getEnv();
  return {
    minimumEdge: env.MINIMUM_EDGE,
    minimumConfidence: env.MINIMUM_CONFIDENCE,
    maximumSpread: env.MAXIMUM_SPREAD,
    minimumSecondsRemaining: env.MINIMUM_SECONDS_REMAINING,
    minimumLiquidity: 10,
    feeCoefficient: env.TAKER_FEE_COEFFICIENT,
    slippage: env.SLIPPAGE_CENTS,
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

export function makeDecision(
  input: DecisionInput,
  config: DecisionConfig = getDefaultDecisionConfig(),
): {
  predictedDirection: PredictedDirection;
  tradeRecommendation: TradeRecommendation;
  recommendation: Recommendation;
  highEdge: number;
  lowEdge: number;
  reasons: string[];
  warnings: string[];
} {
  const reasons: string[] = [];
  const warnings: string[] = [
    "Price feed is not the authoritative Kalshi settlement source",
  ];

  const ev = calculateExpectedValue({
    highProbability: input.highProbability,
    yesAsk: input.yesAsk,
    noAsk: input.noAsk,
    feeCoefficient: config.feeCoefficient,
    slippage: config.slippage,
  });

  const predictedDirection = pickDirection({
    highProbability: input.highProbability,
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
  });

  // ALWAYS_PICK_SIDE only annotates the forecast path; it never forces a trade.
  if (config.alwaysPickSide) {
    reasons.push(
      `Directional forecast: ${predictedDirection} (${(input.highProbability * 100).toFixed(1)}% HIGH)`,
    );
  }

  if (input.dataIsStale) {
    warnings.push("Market data may be stale");
    return noBet("Stale market data", warnings, ev, predictedDirection, reasons);
  }

  if (input.secondsRemaining < config.minimumSecondsRemaining) {
    warnings.push(
      `Only ${input.secondsRemaining}s remaining — late-window signal`,
    );
    return noBet(
      `Only ${input.secondsRemaining}s remaining (minimum ${config.minimumSecondsRemaining}s)`,
      warnings,
      ev,
      predictedDirection,
      reasons,
    );
  }

  const yesSpread = Math.max(0, input.yesAsk - input.yesBid);
  const noSpread = Math.max(0, input.noAsk - input.noBid);
  const maxSpread = Math.max(yesSpread, noSpread);

  if (maxSpread > config.maximumSpread) {
    warnings.push(`Wide spread (${maxSpread.toFixed(2)}) — lower execution quality`);
    return noBet(
      `Spread ${maxSpread.toFixed(2)} exceeds maximum`,
      warnings,
      ev,
      predictedDirection,
      reasons,
    );
  }

  if (
    input.yesLiquidity < config.minimumLiquidity &&
    input.noLiquidity < config.minimumLiquidity
  ) {
    warnings.push("Low Kalshi liquidity");
    return noBet(
      "Insufficient Kalshi liquidity",
      warnings,
      ev,
      predictedDirection,
      reasons,
    );
  }

  if (input.confidence < config.minimumConfidence) {
    warnings.push(
      `Model confidence ${input.confidence.toFixed(2)} below usual threshold`,
    );
    return noBet(
      `Confidence ${input.confidence.toFixed(2)} below minimum`,
      warnings,
      ev,
      predictedDirection,
      reasons,
    );
  }

  appendMarketReasons(input, reasons);

  if (ev.highEdge >= config.minimumEdge && ev.highEdge > ev.lowEdge) {
    reasons.push("Estimated HIGH probability exceeds effective contract cost");
    return {
      predictedDirection,
      tradeRecommendation: "BET_HIGH",
      recommendation: "HIGH",
      highEdge: ev.highEdge,
      lowEdge: ev.lowEdge,
      reasons,
      warnings,
    };
  }

  if (ev.lowEdge >= config.minimumEdge && ev.lowEdge > ev.highEdge) {
    reasons.push("Estimated LOW probability exceeds effective contract cost");
    return {
      predictedDirection,
      tradeRecommendation: "BET_LOW",
      recommendation: "LOW",
      highEdge: ev.highEdge,
      lowEdge: ev.lowEdge,
      reasons,
      warnings,
    };
  }

  reasons.push("No side offers sufficient edge after costs");
  return {
    predictedDirection,
    tradeRecommendation: "NO_BET",
    recommendation: "NO_BET",
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
    reasons,
    warnings,
  };
}

function appendMarketReasons(input: DecisionInput, reasons: string[]): void {
  if (Math.abs(input.distanceToThresholdBps) >= 1) {
    reasons.push(
      `Bitcoin is ${input.distanceToThresholdBps.toFixed(1)} basis points ${input.distanceToThresholdBps >= 0 ? "above" : "below"} the threshold`,
    );
  }

  if (input.momentum30s != null && input.momentum30s > 0) {
    reasons.push("Thirty-second momentum is positive");
  } else if (input.momentum30s != null && input.momentum30s < 0) {
    reasons.push("Thirty-second momentum is negative");
  }

  if (input.momentum3m != null && input.momentum3m > 0) {
    reasons.push("Three-minute momentum is positive");
  }

  if (input.tradeImbalance > 0.1) {
    reasons.push("Aggressive trade flow favors buyers");
  } else if (input.tradeImbalance < -0.1) {
    reasons.push("Aggressive trade flow favors sellers");
  }
}

function noBet(
  reason: string,
  warnings: string[],
  ev: { highEdge: number; lowEdge: number },
  predictedDirection: PredictedDirection,
  priorReasons: string[],
): {
  predictedDirection: PredictedDirection;
  tradeRecommendation: TradeRecommendation;
  recommendation: Recommendation;
  highEdge: number;
  lowEdge: number;
  reasons: string[];
  warnings: string[];
} {
  return {
    predictedDirection,
    tradeRecommendation: "NO_BET",
    recommendation: "NO_BET",
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
    reasons: [...priorReasons, reason],
    warnings,
  };
}

export function buildBetRecommendation(input: {
  marketTicker: string;
  timestamp: number;
  threshold: number;
  btcPrice: number;
  secondsRemaining: number;
  highProbability: number;
  yesAsk: number;
  noAsk: number;
  confidence: number;
  decision: ReturnType<typeof makeDecision>;
}): BetRecommendation {
  return {
    marketTicker: input.marketTicker,
    timestamp: input.timestamp,
    threshold: input.threshold,
    btcPrice: input.btcPrice,
    secondsRemaining: input.secondsRemaining,
    predictedDirection: input.decision.predictedDirection,
    tradeRecommendation: input.decision.tradeRecommendation,
    recommendation: input.decision.recommendation,
    highProbability: input.highProbability,
    lowProbability: 1 - input.highProbability,
    highAsk: input.yesAsk,
    lowAsk: input.noAsk,
    highEdge: input.decision.highEdge,
    lowEdge: input.decision.lowEdge,
    confidence: input.confidence,
    reasons: input.decision.reasons,
    warnings: input.decision.warnings,
  };
}
