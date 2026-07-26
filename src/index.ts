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
import {
  backfillPriceCandles,
  createPriceFeed,
  type SpotFeedService,
} from "./market/price-feed.js";
import type { KalshiMarket } from "./kalshi/kalshi-types.js";
import { KalshiMarketService } from "./kalshi/market-discovery.js";
import {
  blendVolatilityPerSqrtSecond,
  calculateBaselineProbability,
  estimateVolatilityPerSqrtSecond,
  type ProbabilityOutput,
} from "./model/baseline-probability.js";
import { estimateTrend } from "./model/trend-estimator.js";
import { AdaptiveModelService } from "./model/adaptive-model.js";
import type { BetRecommendation } from "./decision/decision-engine.js";
import { startApiServer, updateLiveState } from "./api/server.js";
import { closeDb, getDb } from "./storage/database.js";
import { RecorderService } from "./storage/repositories.js";
import { PaperTrader, type PaperTradeResult } from "./simulation/paper-trader.js";
import { SettlementRecorder } from "./simulation/settlement-recorder.js";

const PRINT_INTERVAL_MS = 5000;

// The prediction is made once, at the start of each 15-minute interval,
// and then locked until the next interval. Wait a short warmup after the
// market opens so the Kalshi book has real quotes, but never wait longer
// than the deadline.
const LOCK_WARMUP_SECONDS = 15;
const LOCK_DEADLINE_SECONDS = 90;

interface LockedPrediction {
  ticker: string;
  market: KalshiMarket;
  probability: ProbabilityOutput;
  recommendation: BetRecommendation;
  paperTrade: PaperTradeResult | null;
  modelParamsId: number | null;
  persisted: boolean;
}

class PredictionEngine {
  private priceFeed: SpotFeedService = createPriceFeed({
    onTrade: (trade) => this.featureEngine.onTrade(trade),
    onState: (state) => this.featureEngine.onBinanceState(state),
    onCandle: (candle) =>
      this.featureEngine.onPrice(candle.timestamp, candle.close),
    onReconnect: () => {
      void backfillPriceCandles((candle) =>
        this.featureEngine.onPrice(candle.timestamp, candle.close),
      );
    },
  });

  private kalshi = new KalshiMarketService();
  private featureEngine = new FeatureEngine();
  private recorder = new RecorderService();
  private paperTrader = new PaperTrader();
  private settlementRecorder = new SettlementRecorder(this.kalshi);
  private adaptiveModel = new AdaptiveModelService();

  private currentMarket: KalshiMarket | null = null;
  private openingBtcPrice: number | null = null;
  private lockedPrediction: LockedPrediction | null = null;
  private persistInFlight = false;
  private lastRecordedSecond: number | null = null;
  private printTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private settlementTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    const env = getEnv();
    logger.info({ priceFeed: env.PRICE_FEED }, "Starting Kalshi BTC prediction engine");

    try {
      getDb();
    } catch (error) {
      logger.warn({ error }, "Database unavailable; running without persistence");
    }

    // Load previously fitted parameters and refit on current history.
    // Falls back to fixed defaults when there is not enough data.
    await this.adaptiveModel.initialize();

    await backfillPriceCandles((candle) =>
      this.featureEngine.onPrice(candle.timestamp, candle.close),
    );

    this.priceFeed.start();
    startApiServer();

    await this.kalshi.start({
      onMarketChange: async (market) => {
        this.currentMarket = market;
        this.openingBtcPrice = this.priceFeed.getState().lastPrice || null;
        this.lockedPrediction = null;
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
      void this.settlementRecorder
        .settleClosedIntervals()
        .then((settledCount) => {
          // Every settlement adds a labeled example; refit so the next
          // interval's prediction uses the newest parameters.
          if (settledCount > 0) {
            return this.adaptiveModel.refit();
          }
        })
        .catch((error) => {
          logger.error({ error }, "Settlement/refit cycle failed");
        });
    }, 30_000);

    void this.tick();
  }

  async stop(): Promise<void> {
    this.priceFeed.stop();
    this.kalshi.stop();
    if (this.printTimer) clearInterval(this.printTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
    await closeDb();
  }

  private async tick(): Promise<void> {
    const market = this.kalshi.getCurrentMarket();
    const kalshiState = this.kalshi.getState();
    const spotState = this.priceFeed.getState();

    if (!market || !kalshiState || spotState.lastPrice <= 0) {
      return;
    }

    const env = getEnv();
    const secondsRemaining = this.kalshi.getSecondsRemaining();
    const threshold = market.floorStrike ?? 0;
    const dataIsStale =
      this.priceFeed.isStale(env.BINANCE_STALE_MS) ||
      this.kalshi.isStale(env.KALSHI_STALE_MS);

    const features = this.featureEngine.computeFeatures({
      binance: spotState,
      kalshi: kalshiState,
      threshold,
      secondsRemaining,
    });

    const marketState = buildPredictionMarketState({
      kalshiTicker: market.ticker,
      threshold,
      intervalStart: market.openTime.getTime(),
      intervalEnd: market.closeTime.getTime(),
      btcPrice: features.currentPrice,
      btcBid: spotState.bid,
      btcAsk: spotState.ask,
      kalshiYesBid: kalshiState.yesBid,
      kalshiYesAsk: kalshiState.yesAsk,
      kalshiNoBid: kalshiState.noBid,
      kalshiNoAsk: kalshiState.noAsk,
      settlementSource: market.settlementSource,
    });

    // One prediction per interval: lock it near the open and never revise.
    if (this.lockedPrediction?.ticker !== market.ticker) {
      const elapsedSeconds =
        (Date.now() - market.openTime.getTime()) / 1000;
      const readyToLock =
        !dataIsStale &&
        kalshiState.yesAsk > 0 &&
        elapsedSeconds >= LOCK_WARMUP_SECONDS;
      const mustLock = elapsedSeconds >= LOCK_DEADLINE_SECONDS;

      if (readyToLock || mustLock) {
        this.lockPrediction({
          market,
          kalshiState,
          features,
          secondsRemaining,
          dataIsStale,
        });
      }
    }

    // Persist (or re-try persisting) the locked prediction and its paper
    // trade. The locked values are never recomputed; only the write is
    // retried, so the stored history always matches what was shown live.
    if (
      this.lockedPrediction?.ticker === market.ticker &&
      !this.lockedPrediction.persisted
    ) {
      await this.persistLockedPrediction(this.lockedPrediction);
    }

    updateLiveState({
      marketState,
      recommendation:
        this.lockedPrediction?.ticker === market.ticker
          ? this.lockedPrediction.recommendation
          : null,
    });
  }

  private lockPrediction(input: {
    market: KalshiMarket;
    kalshiState: NonNullable<ReturnType<KalshiMarketService["getState"]>>;
    features: ReturnType<FeatureEngine["computeFeatures"]>;
    secondsRemaining: number;
    dataIsStale: boolean;
  }): void {
    const { market, kalshiState, features, secondsRemaining, dataIsStale } =
      input;
    const threshold = market.floorStrike ?? 0;

    const adaptiveParams = this.adaptiveModel.getParams();

    const volPerSqrtSecond =
      estimateVolatilityPerSqrtSecond(
        blendVolatilityPerSqrtSecond([
          { value: features.volatilityPerSqrtSecond["volps_60000ms"], weight: 0.4 },
          { value: features.volatilityPerSqrtSecond["volps_300000ms"], weight: 0.4 },
          { value: features.volatilityPerSqrtSecond["volps_900000ms"], weight: 0.2 },
        ]),
        features.currentPrice,
      ) * adaptiveParams.volScale;

    const trend = estimateTrend({
      price: features.currentPrice,
      returnsBps: features.returns,
      tradeImbalance: features.tradeImbalance,
      bookImbalance: features.bookImbalance,
    });

    const probability = calculateBaselineProbability(
      {
        currentPrice: features.currentPrice,
        threshold,
        secondsRemaining,
        volatilityPerSqrtSecond: volPerSqrtSecond,
        driftPerSecond: trend.driftDollarsPerSecond,
      },
      { calibration: adaptiveParams.calibration },
    );

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

    // The paper trade is derived from the same locked recommendation at
    // the same moment, so the bet always mirrors the prediction.
    const paperTrade = this.paperTrader.maybeCreateTrade({ recommendation });

    this.lockedPrediction = {
      ticker: market.ticker,
      market,
      probability,
      recommendation,
      paperTrade,
      modelParamsId: adaptiveParams.paramsId,
      persisted: false,
    };

    logger.info(
      {
        ticker: market.ticker,
        recommendation: recommendation.recommendation,
        highProbability: recommendation.highProbability.toFixed(3),
        highEdge: recommendation.highEdge.toFixed(3),
        lowEdge: recommendation.lowEdge.toFixed(3),
        driftBpsPerSecond: trend.driftBpsPerSecond.toFixed(4),
        remainingStdDev: probability.remainingStdDev.toFixed(2),
        paperTradeSide: paperTrade?.side ?? null,
        modelParamsId: adaptiveParams.paramsId,
        volScale: adaptiveParams.volScale,
        calibrated: adaptiveParams.calibration != null,
        secondsRemaining,
      },
      "Prediction locked for interval",
    );
  }

  private async persistLockedPrediction(
    locked: LockedPrediction,
  ): Promise<void> {
    if (this.persistInFlight) return;
    this.persistInFlight = true;
    try {
      const predictionId = await this.recorder.recordPredictionAndTrade({
        market: locked.market,
        openingBtcPrice: this.openingBtcPrice ?? undefined,
        probability: locked.probability,
        recommendation: locked.recommendation,
        paperTrade: locked.paperTrade,
        modelParamsId: locked.modelParamsId,
      });
      locked.persisted = true;
      logger.info(
        {
          predictionId,
          ticker: locked.ticker,
          paperTradeSide: locked.paperTrade?.side ?? null,
        },
        "Prediction and paper trade persisted",
      );
    } catch (error) {
      logger.error(
        { error, ticker: locked.ticker },
        "Failed to persist locked prediction; will retry",
      );
    } finally {
      this.persistInFlight = false;
    }
  }

  private async printSnapshot(): Promise<void> {
    const market = this.kalshi.getCurrentMarket();
    const kalshiState = this.kalshi.getState();
    const spotState = this.priceFeed.getState();

    if (!market || !kalshiState || spotState.lastPrice <= 0) {
      logger.warn("Waiting for market data...");
      return;
    }

    const state = buildPredictionMarketState({
      kalshiTicker: market.ticker,
      threshold: market.floorStrike ?? 0,
      intervalStart: market.openTime.getTime(),
      intervalEnd: market.closeTime.getTime(),
      btcPrice: spotState.lastPrice,
      btcBid: spotState.bid,
      btcAsk: spotState.ask,
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
    const spotState = this.priceFeed.getState();

    if (!market || !kalshiState || spotState.lastPrice <= 0) {
      return;
    }

    const secondsRemaining = this.kalshi.getSecondsRemaining();
    if (this.lastRecordedSecond === secondsRemaining) {
      return;
    }
    this.lastRecordedSecond = secondsRemaining;

    const threshold = market.floorStrike ?? 0;
    const features = this.featureEngine.computeFeatures({
      binance: spotState,
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
      btcBid: spotState.bid,
      btcAsk: spotState.ask,
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
