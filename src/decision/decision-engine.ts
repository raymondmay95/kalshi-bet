import { getEnv } from "../config/environment.js";
import { calculateExpectedValue } from "./fees.js";

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
}): "HIGH" | "LOW" {
  if (input.highEdge > input.lowEdge) return "HIGH";
  if (input.lowEdge > input.highEdge) return "LOW";
  return input.highProbability >= 0.5 ? "HIGH" : "LOW";
}

export function makeDecision(
  input: DecisionInput,
  config: DecisionConfig = getDefaultDecisionConfig(),
): {
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

  if (input.dataIsStale) {
    warnings.push("Market data may be stale");
    if (!config.alwaysPickSide) {
      return noBet("Stale market data", warnings, ev);
    }
  }

  if (input.secondsRemaining < config.minimumSecondsRemaining) {
    warnings.push(
      `Only ${input.secondsRemaining}s remaining — late-window signal`,
    );
    if (!config.alwaysPickSide) {
      return noBet(
        `Only ${input.secondsRemaining}s remaining (minimum ${config.minimumSecondsRemaining}s)`,
        warnings,
        ev,
      );
    }
  }

  const yesSpread = Math.max(0, input.yesAsk - input.yesBid);
  const noSpread = Math.max(0, input.noAsk - input.noBid);
  const maxSpread = Math.max(yesSpread, noSpread);

  if (maxSpread > config.maximumSpread) {
    warnings.push(`Wide spread (${maxSpread.toFixed(2)}) — lower execution quality`);
    if (!config.alwaysPickSide) {
      return noBet(`Spread ${maxSpread.toFixed(2)} exceeds maximum`, warnings, ev);
    }
  }

  if (
    input.yesLiquidity < config.minimumLiquidity &&
    input.noLiquidity < config.minimumLiquidity
  ) {
    warnings.push("Low Kalshi liquidity");
    if (!config.alwaysPickSide) {
      return noBet("Insufficient Kalshi liquidity", warnings, ev);
    }
  }

  if (input.confidence < config.minimumConfidence) {
    warnings.push(
      `Model confidence ${input.confidence.toFixed(2)} below usual threshold`,
    );
    if (!config.alwaysPickSide) {
      return noBet(
        `Confidence ${input.confidence.toFixed(2)} below minimum`,
        warnings,
        ev,
      );
    }
  }

  appendMarketReasons(input, reasons);

  if (
    ev.highEdge >= config.minimumEdge &&
    ev.highEdge > ev.lowEdge
  ) {
    reasons.push("Estimated HIGH probability exceeds effective contract cost");
    return {
      recommendation: "HIGH",
      highEdge: ev.highEdge,
      lowEdge: ev.lowEdge,
      reasons,
      warnings,
    };
  }

  if (
    ev.lowEdge >= config.minimumEdge &&
    ev.lowEdge > ev.highEdge
  ) {
    reasons.push("Estimated LOW probability exceeds effective contract cost");
    return {
      recommendation: "LOW",
      highEdge: ev.highEdge,
      lowEdge: ev.lowEdge,
      reasons,
      warnings,
    };
  }

  const direction = pickDirection({
    highProbability: input.highProbability,
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
  });

  if (config.alwaysPickSide) {
    reasons.push(
      direction === "HIGH"
        ? `Best estimate: ${(input.highProbability * 100).toFixed(1)}% chance above strike (HIGH edge ${ev.highEdge.toFixed(3)})`
        : `Best estimate: ${((1 - input.highProbability) * 100).toFixed(1)}% chance below strike (LOW edge ${ev.lowEdge.toFixed(3)})`,
    );
    return {
      recommendation: direction,
      highEdge: ev.highEdge,
      lowEdge: ev.lowEdge,
      reasons,
      warnings,
    };
  }

  reasons.push("No side offers sufficient edge after costs");
  return {
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
): {
  recommendation: Recommendation;
  highEdge: number;
  lowEdge: number;
  reasons: string[];
  warnings: string[];
} {
  return {
    recommendation: "NO_BET",
    highEdge: ev.highEdge,
    lowEdge: ev.lowEdge,
    reasons: [reason],
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
