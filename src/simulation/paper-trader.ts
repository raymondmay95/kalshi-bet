import { getEnv } from "../config/environment.js";
import type { BetRecommendation } from "../decision/decision-engine.js";
import { kalshiFee } from "../decision/fees.js";
import { calculatePositionSize } from "../decision/position-sizing.js";

export interface PaperTradeInput {
  recommendation: BetRecommendation;
}

export interface PaperTradeResult {
  side: "HIGH" | "LOW";
  entryPrice: number;
  quantity: number;
  simulatedFees: number;
}

export class PaperTrader {
  private readonly enabled: boolean;

  constructor(enabled?: boolean) {
    this.enabled = enabled ?? getEnv().PAPER_TRADING;
  }

  maybeCreateTrade(input: PaperTradeInput): PaperTradeResult | null {
    if (!this.enabled) return null;

    const trade = input.recommendation.tradeRecommendation;
    if (trade === "NO_BET") return null;

    const env = getEnv();
    const side = trade === "BET_HIGH" ? "HIGH" : "LOW";
    const entryPrice =
      side === "HIGH"
        ? input.recommendation.highAsk
        : input.recommendation.lowAsk;

    // Size from the Kelly fraction the decision engine already computed, so a
    // thin edge is staked small instead of the same size as a strong one.
    const { contracts } = calculatePositionSize({
      edge: input.recommendation.bestEdge,
      cost: input.recommendation.bestCost,
      bankroll: env.PAPER_BANKROLL,
      kellyMultiplier: env.KELLY_MULTIPLIER,
      maximumPositionFraction: env.MAXIMUM_STAKE_FRACTION,
    });
    const quantity = Math.max(1, contracts);
    const simulatedFees = kalshiFee(
      entryPrice,
      quantity,
      env.TAKER_FEE_COEFFICIENT,
    );

    return {
      side,
      entryPrice: entryPrice + env.SLIPPAGE_CENTS,
      quantity,
      simulatedFees,
    };
  }
}

export function calculateSettlementPnl(input: {
  side: "HIGH" | "LOW";
  entryPrice: number;
  quantity: number;
  simulatedFees: number;
  finalResult: "yes" | "no";
}): { settlementValue: number; profitLoss: number } {
  const won =
    (input.side === "HIGH" && input.finalResult === "yes") ||
    (input.side === "LOW" && input.finalResult === "no");

  const settlementValue = won ? 1 : 0;
  const totalCost =
    input.entryPrice * input.quantity + input.simulatedFees;
  const payout = settlementValue * input.quantity;
  const profitLoss = payout - totalCost;

  return { settlementValue, profitLoss };
}
