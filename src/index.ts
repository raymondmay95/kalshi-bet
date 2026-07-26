import { backfillCandles } from "./binance/binance-client.js";
import { BinanceFeedService } from "./binance/binance-feed.js";
import { getEnv } from "./config/environment.js";
import { logger } from "./config/logger.js";
import {
  buildBetRecommendation,
  makeDecision,
} from "./decision/decision-engine.js";
import { FeatureEngine } from "./market/feature-engine.js";
import {
  buildPredictionMarketState,
  formatSnapshotLine,
} from "./market/market-state.js";
import type { KalshiMarket } from "./kalshi/kalshi-types.js";
import { KalshiMarketService } from "./kalshi/market-discovery.js";
import {
  calculateBaselineProbability,
  estimateVolatilityPerSqrtSecond,
} from "./model/baseline-probability.js";
import { startApiServer, updateLiveState } from "./api/server.js";
import { closeDb, getDb } from "./storage/database.js";
import { RecorderService } from "./storage/repositories.js";
import { PaperTrader } from "./simulation/paper-trader.js";
import { SettlementRecorder } from "./simulation/settlement-recorder.js";

const DECISION_INTERVALS_SECONDS = [600, 300, 180, 120, 60, 30];
const PRINT_INTERVAL_MS = 5000;

class PredictionEngine {
  private binance = new BinanceFeedService({
    onTrade: (trade) => this.featureEngine.onTrade(trade),
    onState: (state) => this.featureEngine.onBinanceState(state),
    onCandle: (candle) =>
      this.featureEngine.onPrice(candle.timestamp, candle.close),
    onReconnect: () => {
      void backfillCandles((candle) =>
        this.featureEngine.onPrice(candle.timestamp, candle.close),
      );
    },
  });

  private kalshi = new KalshiMarketService();
  private featureEngine = new FeatureEngine();
  private recorder = new RecorderService();
  private paperTrader = new PaperTrader();
  private settlementRecorder = new SettlementRecorder(this.kalshi);

  private currentMarket: KalshiMarket | null = null;
  private openingBtcPrice: number | null = null;
  private lastDecisionAtSecond: number | null = null;
  private lastRecordedSecond: number | null = null;
  private printTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private settlementTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    const env = getEnv();
    logger.info("Starting Kalshi BTC prediction engine");

    try {
      getDb();
    } catch (error) {
      logger.warn({ error }, "Database unavailable; running without persistence");
    }

    await backfillCandles((candle) =>
      this.featureEngine.onPrice(candle.timestamp, candle.close),
    );

    this.binance.start();
    startApiServer();

    await this.kalshi.start({
      onMarketChange: async (market) => {
        this.currentMarket = market;
        this.openingBtcPrice = this.binance.getState().lastPrice || null;
        this.lastDecisionAtSecond = null;
        this.lastRecordedSecond = null;
        try {
          await this.recorder.ensureMarketInterval(market, this.openingBtcPrice ?? undefined);
        } catch (error) {
          logger.error({ error }, "Failed to ensure market interval");
        }
      },
      onStateUpdate: () => {
        void this.tick();
      },
    });

    this.currentMarket = this.kalshi.getCurrentMarket();
    if (this.currentMarket) {
      try {
        await this.recorder.ensureMarketInterval(this.currentMarket);
      } catch (error) {
        logger.error({ error }, "Failed to create initial market interval");
      }
    }

    this.printTimer = setInterval(() => {
      void this.printSnapshot();
    }, PRINT_INTERVAL_MS);

    this.snapshotTimer = setInterval(() => {
      void this.recordSnapshot();
    }, env.SNAPSHOT_INTERVAL_MS);

    this.settlementTimer = setInterval(() => {
      void this.settlementRecorder.settleClosedIntervals();
    }, 30_000);

    void this.tick();
  }

  async stop(): Promise<void> {
    this.binance.stop();
    this.kalshi.stop();
    if (this.printTimer) clearInterval(this.printTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
    await closeDb();
  }

  private async tick(): Promise<void> {
    const market = this.kalshi.getCurrentMarket();
    const kalshiState = this.kalshi.getState();
    const binanceState = this.binance.getState();

    if (!market || !kalshiState || binanceState.lastPrice <= 0) {
      return;
    }

    const env = getEnv();
    const secondsRemaining = this.kalshi.getSecondsRemaining();
    const threshold = market.floorStrike ?? 0;
    const dataIsStale =
      this.binance.isStale(env.BINANCE_STALE_MS) ||
      this.kalshi.isStale(env.KALSHI_STALE_MS);

    const features = this.featureEngine.computeFeatures({
      binance: binanceState,
      kalshi: kalshiState,
      threshold,
      secondsRemaining,
    });

    const volPerSqrtSecond = estimateVolatilityPerSqrtSecond(
      features.realizedVolatility["vol_60000ms"],
      features.currentPrice,
    );

    const probability = calculateBaselineProbability({
      currentPrice: features.currentPrice,
      threshold,
      secondsRemaining,
      volatilityPerSqrtSecond: volPerSqrtSecond,
    });

    const decision = makeDecision({
      highProbability: probability.adjustedHighProbability,
      confidence: probability.confidence,
      yesBid: kalshiState.yesBid,
      yesAsk: kalshiState.yesAsk,
      noBid: kalshiState.noBid,
      noAsk: kalshiState.noAsk,
      yesLiquidity: kalshiState.yesLiquidity,
      noLiquidity: kalshiState.noLiquidity,
      secondsRemaining,
      dataIsStale,
      distanceToThresholdBps: features.distanceToThresholdBps,
      tradeImbalance: features.tradeImbalance,
      momentum30s: features.returns["return_30000ms_bps"] ?? null,
      momentum3m: features.returns["return_180000ms_bps"] ?? null,
    });

    const marketState = buildPredictionMarketState({
      kalshiTicker: market.ticker,
      threshold,
      intervalStart: market.openTime.getTime(),
      intervalEnd: market.closeTime.getTime(),
      btcPrice: features.currentPrice,
      btcBid: binanceState.bid,
      btcAsk: binanceState.ask,
      kalshiYesBid: kalshiState.yesBid,
      kalshiYesAsk: kalshiState.yesAsk,
      kalshiNoBid: kalshiState.noBid,
      kalshiNoAsk: kalshiState.noAsk,
      settlementSource: market.settlementSource,
    });

    const recommendation = buildBetRecommendation({
      marketTicker: market.ticker,
      timestamp: Date.now(),
      threshold,
      btcPrice: features.currentPrice,
      secondsRemaining,
      highProbability: probability.adjustedHighProbability,
      yesAsk: kalshiState.yesAsk,
      noAsk: kalshiState.noAsk,
      confidence: probability.confidence,
      decision,
    });

    updateLiveState({ marketState, recommendation });

    const shouldDecide = DECISION_INTERVALS_SECONDS.some(
      (bucket) =>
        secondsRemaining <= bucket &&
        (this.lastDecisionAtSecond == null ||
          this.lastDecisionAtSecond > bucket),
    );

    if (shouldDecide) {
      this.lastDecisionAtSecond = secondsRemaining;
      try {
        const predictionId = await this.recorder.recordPrediction({
          probability,
          recommendation,
        });

        if (predictionId) {
          const paperTrade = this.paperTrader.maybeCreateTrade({
            predictionId,
            recommendation,
          });
          if (paperTrade) {
            await this.recorder.recordPaperTrade({
              predictionId,
              ...paperTrade,
            });
            logger.info(
              {
                side: paperTrade.side,
                entryPrice: paperTrade.entryPrice,
                ticker: market.ticker,
              },
              "Paper trade recorded",
            );
          }
        }

        logger.info(
          {
            recommendation: recommendation.recommendation,
            highProbability: recommendation.highProbability.toFixed(3),
            highEdge: recommendation.highEdge.toFixed(3),
            lowEdge: recommendation.lowEdge.toFixed(3),
            secondsRemaining,
          },
          "Decision snapshot",
        );
      } catch (error) {
        logger.error({ error }, "Failed to record prediction");
      }
    }
  }

  private async printSnapshot(): Promise<void> {
    const market = this.kalshi.getCurrentMarket();
    const kalshiState = this.kalshi.getState();
    const binanceState = this.binance.getState();

    if (!market || !kalshiState || binanceState.lastPrice <= 0) {
      logger.warn("Waiting for market data...");
      return;
    }

    const state = buildPredictionMarketState({
      kalshiTicker: market.ticker,
      threshold: market.floorStrike ?? 0,
      intervalStart: market.openTime.getTime(),
      intervalEnd: market.closeTime.getTime(),
      btcPrice: binanceState.lastPrice,
      btcBid: binanceState.bid,
      btcAsk: binanceState.ask,
      kalshiYesBid: kalshiState.yesBid,
      kalshiYesAsk: kalshiState.yesAsk,
      kalshiNoBid: kalshiState.noBid,
      kalshiNoAsk: kalshiState.noAsk,
      settlementSource: market.settlementSource,
    });

    logger.info(formatSnapshotLine(state));
  }

  private async recordSnapshot(): Promise<void> {
    const market = this.kalshi.getCurrentMarket();
    const kalshiState = this.kalshi.getState();
    const binanceState = this.binance.getState();

    if (!market || !kalshiState || binanceState.lastPrice <= 0) {
      return;
    }

    const secondsRemaining = this.kalshi.getSecondsRemaining();
    if (this.lastRecordedSecond === secondsRemaining) {
      return;
    }
    this.lastRecordedSecond = secondsRemaining;

    const threshold = market.floorStrike ?? 0;
    const features = this.featureEngine.computeFeatures({
      binance: binanceState,
      kalshi: kalshiState,
      threshold,
      secondsRemaining,
    });

    const state = buildPredictionMarketState({
      kalshiTicker: market.ticker,
      threshold,
      intervalStart: market.openTime.getTime(),
      intervalEnd: market.closeTime.getTime(),
      btcPrice: features.currentPrice,
      btcBid: binanceState.bid,
      btcAsk: binanceState.ask,
      kalshiYesBid: kalshiState.yesBid,
      kalshiYesAsk: kalshiState.yesAsk,
      kalshiNoBid: kalshiState.noBid,
      kalshiNoAsk: kalshiState.noAsk,
      settlementSource: market.settlementSource,
    });

    try {
      await this.recorder.recordSnapshot({
        state,
        features,
        kalshiFeatures: {
          yesSpread: kalshiState.yesSpread,
          noSpread: kalshiState.noSpread,
          yesLiquidity: kalshiState.yesLiquidity,
          noLiquidity: kalshiState.noLiquidity,
        },
      });
    } catch (error) {
      logger.error({ error }, "Failed to record snapshot");
    }
  }
}

const engine = new PredictionEngine();

engine.start().catch((error) => {
  logger.error({ error }, "Failed to start engine");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info("Shutting down...");
    await engine.stop();
    process.exit(0);
  });
}
