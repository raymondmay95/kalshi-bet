import { getEnv } from "../config/environment.js";
import type { BetRecommendation } from "../decision/decision-engine.js";
import { kalshiFee } from "../decision/fees.js";

export interface PaperTradeInput {
  predictionId: number;
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
    if (input.recommendation.recommendation === "NO_BET") return null;

    const side = input.recommendation.recommendation;
    const entryPrice =
      side === "HIGH"
        ? input.recommendation.highAsk
        : input.recommendation.lowAsk;
    const quantity = 1;
    const simulatedFees = kalshiFee(
      entryPrice,
      quantity,
      getEnv().TAKER_FEE_COEFFICIENT,
    );

    return {
      side,
      entryPrice: entryPrice + getEnv().SLIPPAGE_CENTS,
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
