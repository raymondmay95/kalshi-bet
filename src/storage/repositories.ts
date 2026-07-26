import { eq } from "drizzle-orm";
import type { BetRecommendation } from "../decision/decision-engine.js";
import type { FeatureSnapshot } from "../market/feature-engine.js";
import type { KalshiMarket } from "../kalshi/kalshi-types.js";
import type { PredictionMarketState } from "../market/market-state.js";
import type { PaperTradeResult } from "../simulation/paper-trader.js";
import { BASELINE_MODEL } from "../model/model-types.js";
import type { ProbabilityOutput } from "../model/baseline-probability.js";
import {
  noteDbError,
  noteDbInsertLatency,
} from "../prediction/observability.js";
import { getDb } from "./database.js";
import {
  marketIntervals,
  marketSnapshots,
  paperTrades,
  predictions,
} from "./schema.js";

export interface PredictionPersistInput {
  market: KalshiMarket;
  openingBtcPrice?: number;
  probability: ProbabilityOutput;
  recommendation: BetRecommendation;
  paperTrade: PaperTradeResult | null;
  modelParamsId?: number | null;
  inputVersion?: number | null;
  inputTimestamp?: number | null;
  monteCarloHighProbability?: number | null;
  estimatedSettlementPrice?: number | null;
  simulationPathCount?: number | null;
  simulationDurationMs?: number | null;
  staleResult?: boolean;
  modelVersion?: string;
}

export class RecorderService {
  private currentIntervalId: number | null = null;
  private writeQueue: Array<() => Promise<void>> = [];
  private draining = false;

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

  /** Queue a snapshot write so WebSocket handlers never await Postgres. */
  enqueueSnapshot(input: {
    state: PredictionMarketState;
    features: FeatureSnapshot;
    kalshiFeatures: Record<string, unknown>;
  }): void {
    this.enqueue(async () => {
      await this.recordSnapshot(input);
    });
  }

  /** Queue a prediction write off the hot path. */
  enqueuePrediction(input: PredictionPersistInput): void {
    this.enqueue(async () => {
      await this.recordPredictionAndTrade(input);
    });
  }

  async recordSnapshot(input: {
    state: PredictionMarketState;
    features: FeatureSnapshot;
    kalshiFeatures: Record<string, unknown>;
  }): Promise<void> {
    if (!this.currentIntervalId) return;

    const started = performance.now();
    try {
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
      noteDbInsertLatency(performance.now() - started);
    } catch (error) {
      noteDbError();
      throw error;
    }
  }

  async recordPredictionAndTrade(
    input: PredictionPersistInput,
  ): Promise<number> {
    const intervalId = await this.ensureMarketInterval(
      input.market,
      input.openingBtcPrice,
    );

    const started = performance.now();
    try {
      const db = getDb();
      return await db.transaction(async (tx) => {
        const calibrated =
          input.recommendation.highProbability;
        const expectedValue = Math.max(
          input.recommendation.highEdge,
          input.recommendation.lowEdge,
        );

        const inserted = await tx
          .insert(predictions)
          .values({
            marketIntervalId: intervalId,
            timestamp: new Date(input.recommendation.timestamp),
            inputTimestamp: input.inputTimestamp
              ? new Date(input.inputTimestamp)
              : new Date(input.recommendation.timestamp),
            inputVersion: input.inputVersion ?? null,
            modelVersion:
              input.modelVersion ??
              `${BASELINE_MODEL.name}@${BASELINE_MODEL.version}`,
            rawHighProbability: input.probability.rawHighProbability,
            adjustedHighProbability: input.recommendation.highProbability,
            monteCarloHighProbability: input.monteCarloHighProbability ?? null,
            calibratedHighProbability: calibrated,
            estimatedSettlementPrice: input.estimatedSettlementPrice ?? null,
            strike: input.recommendation.threshold,
            highEdge: input.recommendation.highEdge,
            lowEdge: input.recommendation.lowEdge,
            recommendation: input.recommendation.recommendation,
            predictedDirection: input.recommendation.predictedDirection,
            tradeRecommendation: input.recommendation.tradeRecommendation,
            confidence: input.recommendation.confidence,
            secondsRemaining: input.recommendation.secondsRemaining,
            btcPrice: input.recommendation.btcPrice,
            remainingStdDev: input.probability.remainingStdDev,
            zScore: input.probability.zScore,
            appliedDrift: input.probability.appliedDrift,
            modelParamsId: input.modelParamsId ?? null,
            simulationPathCount: input.simulationPathCount ?? null,
            simulationDurationMs: input.simulationDurationMs ?? null,
            staleResult: input.staleResult ?? false,
            expectedValue,
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

        noteDbInsertLatency(performance.now() - started);
        return predictionId;
      });
    } catch (error) {
      noteDbError();
      throw error;
    }
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

  private enqueue(task: () => Promise<void>): void {
    this.writeQueue.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.writeQueue.length > 0) {
        const task = this.writeQueue.shift();
        if (!task) break;
        try {
          await task();
        } catch {
          // Errors are recorded via noteDbError in the task.
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
