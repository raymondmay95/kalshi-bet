import { eq } from "drizzle-orm";
import type { BetRecommendation } from "../decision/decision-engine.js";
import type { FeatureSnapshot } from "../market/feature-engine.js";
import type { KalshiMarket } from "../kalshi/kalshi-types.js";
import type { PredictionMarketState } from "../market/market-state.js";
import type { PaperTradeResult } from "../simulation/paper-trader.js";
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

    // onConflictDoNothing + re-select keeps this safe against concurrent
    // callers racing to create the same interval (ticker is unique).
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
      .onConflictDoNothing({ target: marketIntervals.kalshiTicker })
      .returning({ id: marketIntervals.id });

    if (inserted[0]) {
      this.currentIntervalId = inserted[0].id;
      return inserted[0].id;
    }

    const winner = await db
      .select()
      .from(marketIntervals)
      .where(eq(marketIntervals.kalshiTicker, market.ticker))
      .limit(1);
    this.currentIntervalId = winner[0]!.id;
    return winner[0]!.id;
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

  /**
   * Atomically persist a locked prediction and its paper trade.
   *
   * The interval is resolved from the market the prediction was made for
   * (not from shared mutable state), so the prediction can never be
   * attached to a stale interval. Both rows are written in one
   * transaction: either the prediction and its bet both exist, or
   * neither does.
   */
  async recordPredictionAndTrade(input: {
    market: KalshiMarket;
    openingBtcPrice?: number;
    probability: ProbabilityOutput;
    recommendation: BetRecommendation;
    paperTrade: PaperTradeResult | null;
    modelParamsId?: number | null;
  }): Promise<number> {
    const intervalId = await this.ensureMarketInterval(
      input.market,
      input.openingBtcPrice,
    );

    const db = getDb();
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(predictions)
        .values({
          marketIntervalId: intervalId,
          timestamp: new Date(input.recommendation.timestamp),
          modelVersion: `${BASELINE_MODEL.name}@${BASELINE_MODEL.version}`,
          rawHighProbability: input.probability.rawHighProbability,
          adjustedHighProbability: input.recommendation.highProbability,
          highEdge: input.recommendation.highEdge,
          lowEdge: input.recommendation.lowEdge,
          recommendation: input.recommendation.recommendation,
          confidence: input.recommendation.confidence,
          secondsRemaining: input.recommendation.secondsRemaining,
          btcPrice: input.recommendation.btcPrice,
          remainingStdDev: input.probability.remainingStdDev,
          zScore: input.probability.zScore,
          appliedDrift: input.probability.appliedDrift,
          modelParamsId: input.modelParamsId ?? null,
          reasonCodes: {
            reasons: input.recommendation.reasons,
            warnings: input.recommendation.warnings,
          },
        })
        .returning({ id: predictions.id });

      const predictionId = inserted[0]!.id;

      if (input.paperTrade) {
        await tx.insert(paperTrades).values({
          predictionId,
          side: input.paperTrade.side,
          entryPrice: input.paperTrade.entryPrice,
          quantity: input.paperTrade.quantity,
          simulatedFees: input.paperTrade.simulatedFees,
        });
      }

      return predictionId;
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
