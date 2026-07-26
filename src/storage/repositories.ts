import { eq } from "drizzle-orm";
import type { BetRecommendation } from "../decision/decision-engine.js";
import type { FeatureSnapshot } from "../market/feature-engine.js";
import type { KalshiMarket } from "../kalshi/kalshi-types.js";
import type { PredictionMarketState } from "../market/market-state.js";
import { BASELINE_MODEL } from "../model/model-types.js";
import type { ProbabilityOutput } from "../model/baseline-probability.js";
import { getDb } from "./database.js";
import {
  marketIntervals,
  marketSnapshots,
  paperTrades,
  predictions,
} from "./schema.js";

export class RecorderService {
  private currentIntervalId: number | null = null;

  async ensureMarketInterval(
    market: KalshiMarket,
    openingBtcPrice?: number,
  ): Promise<number> {
    const db = getDb();
    const existing = await db
      .select()
      .from(marketIntervals)
      .where(eq(marketIntervals.kalshiTicker, market.ticker))
      .limit(1);

    if (existing[0]) {
      this.currentIntervalId = existing[0].id;
      return existing[0].id;
    }

    const openingBasisBps =
      openingBtcPrice != null && market.floorStrike
        ? ((openingBtcPrice - market.floorStrike) / market.floorStrike) * 10_000
        : null;

    const inserted = await db
      .insert(marketIntervals)
      .values({
        kalshiTicker: market.ticker,
        threshold: market.floorStrike ?? 0,
        intervalStart: market.openTime,
        intervalEnd: market.closeTime,
        settlementSource: market.settlementSource,
        settlementRule: market.settlementRule,
        openingBasisBps,
      })
      .returning({ id: marketIntervals.id });

    this.currentIntervalId = inserted[0]!.id;
    return inserted[0]!.id;
  }

  async recordSnapshot(input: {
    state: PredictionMarketState;
    features: FeatureSnapshot;
    kalshiFeatures: Record<string, unknown>;
  }): Promise<void> {
    if (!this.currentIntervalId) return;

    const db = getDb();
    await db.insert(marketSnapshots).values({
      marketIntervalId: this.currentIntervalId,
      timestamp: new Date(input.state.dataUpdatedAt),
      secondsRemaining: input.state.secondsRemaining,
      btcPrice: input.state.btcPrice,
      btcBid: input.state.btcBid,
      btcAsk: input.state.btcAsk,
      yesBid: input.state.kalshiYesBid,
      yesAsk: input.state.kalshiYesAsk,
      noBid: input.state.kalshiNoBid,
      noAsk: input.state.kalshiNoAsk,
      binanceFeaturesJson: input.features,
      kalshiFeaturesJson: input.kalshiFeatures,
    });
  }

  async recordPrediction(input: {
    probability: ProbabilityOutput;
    recommendation: BetRecommendation;
  }): Promise<number | null> {
    if (!this.currentIntervalId) return null;

    const db = getDb();
    const inserted = await db
      .insert(predictions)
      .values({
        marketIntervalId: this.currentIntervalId,
        timestamp: new Date(input.recommendation.timestamp),
        modelVersion: `${BASELINE_MODEL.name}@${BASELINE_MODEL.version}`,
        rawHighProbability: input.probability.rawHighProbability,
        adjustedHighProbability: input.recommendation.highProbability,
        highEdge: input.recommendation.highEdge,
        lowEdge: input.recommendation.lowEdge,
        recommendation: input.recommendation.recommendation,
        confidence: input.recommendation.confidence,
        secondsRemaining: input.recommendation.secondsRemaining,
        reasonCodes: {
          reasons: input.recommendation.reasons,
          warnings: input.recommendation.warnings,
        },
      })
      .returning({ id: predictions.id });

    return inserted[0]?.id ?? null;
  }

  async recordPaperTrade(input: {
    predictionId: number;
    side: "HIGH" | "LOW";
    entryPrice: number;
    quantity: number;
    simulatedFees: number;
  }): Promise<void> {
    const db = getDb();
    await db.insert(paperTrades).values({
      predictionId: input.predictionId,
      side: input.side,
      entryPrice: input.entryPrice,
      quantity: input.quantity,
      simulatedFees: input.simulatedFees,
    });
  }

  async updateSettlement(
    ticker: string,
    result: "yes" | "no",
  ): Promise<void> {
    const db = getDb();
    await db
      .update(marketIntervals)
      .set({ finalResult: result })
      .where(eq(marketIntervals.kalshiTicker, ticker));
  }

  setCurrentIntervalId(id: number | null): void {
    this.currentIntervalId = id;
  }

  getCurrentIntervalId(): number | null {
    return this.currentIntervalId;
  }
}
