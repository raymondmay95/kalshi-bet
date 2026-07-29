import { getEnv } from "./config/environment.js";
import { logger } from "./config/logger.js";
import {
  buildBetRecommendation,
  makeDecision,
  type BetRecommendation,
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
import { estimateProbabilityUncertainty } from "./model/probability-uncertainty.js";
import { estimateTrend } from "./model/trend-estimator.js";
import { AdaptiveModelService } from "./model/adaptive-model.js";
import { BASELINE_MODEL } from "./model/model-types.js";
import { startApiServer, updateLiveState } from "./api/server.js";
import { closeDb, getDb } from "./storage/database.js";
import { RecorderService } from "./storage/repositories.js";
import { RetentionService } from "./storage/retention.js";
import { PaperTrader, type PaperTradeResult } from "./simulation/paper-trader.js";
import { SettlementRecorder } from "./simulation/settlement-recorder.js";
import type { PredictionJobResult } from "./prediction/job-types.js";
import {
  noteMarketDataMessage,
  noteReconnect,
  getEngineMetrics,
  updateWorkerMetrics,
} from "./prediction/observability.js";
import { PredictionScheduler } from "./prediction/scheduler.js";

const PRINT_INTERVAL_MS = 5000;

interface LivePrediction {
  ticker: string;
  market: KalshiMarket;
  probability: ProbabilityOutput;
  recommendation: BetRecommendation;
  monteCarloHighProbability: number | null;
  estimatedSettlementPrice: number | null;
  simulationPathCount: number | null;
  simulationDurationMs: number | null;
  inputVersion: number;
  modelParamsId: number | null;
  paperTrade: PaperTradeResult | null;
}

class PredictionEngine {
  private priceFeed: SpotFeedService = createPriceFeed({
    onTrade: (trade) => {
      noteMarketDataMessage();
      this.featureEngine.onTrade(trade);
    },
    onState: (state) => {
      noteMarketDataMessage();
      this.featureEngine.onBinanceState(state);
    },
    onCandle: (candle) =>
      this.featureEngine.onPrice(candle.timestamp, candle.close),
    onReconnect: () => {
      noteReconnect();
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
  private scheduler = new PredictionScheduler();
  private retention = new RetentionService();

  private currentMarket: KalshiMarket | null = null;
  private openingBtcPrice: number | null = null;
  private livePrediction: LivePrediction | null = null;
  private paperTradePlacedForTicker: string | null = null;
  private lastPersistedAt = 0;
  private lastPersistedTrade: string | null = null;
  private lastRecordedSecond: number | null = null;
  private printTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private settlementTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  async start(): Promise<void> {
    const env = getEnv();
    logger.info(
      { priceFeed: env.PRICE_FEED, monteCarlo: env.MONTE_CARLO_ENABLED },
      "Starting Kalshi BTC prediction engine",
    );

    try {
      getDb();
    } catch (error) {
      logger.warn({ error }, "Database unavailable; running without persistence");
    }

    await this.adaptiveModel.initialize();

    await backfillPriceCandles((candle) =>
      this.featureEngine.onPrice(candle.timestamp, candle.close),
    );

    this.priceFeed.start();
    startApiServer(() => getEngineMetrics());

    this.scheduler.start({
      onAnalyticalDue: () => {
        void this.runAnalytical("schedule");
      },
      onMonteCarloResult: (result) => {
        this.applyMonteCarloResult(result);
      },
    });

    this.retention.start();

    await this.kalshi.start({
      onMarketChange: async (market) => {
        this.currentMarket = market;
        this.openingBtcPrice = this.priceFeed.getState().lastPrice || null;
        this.livePrediction = null;
        this.paperTradePlacedForTicker = null;
        this.lastPersistedTrade = null;
        this.lastRecordedSecond = null;
        try {
          await this.recorder.ensureMarketInterval(
            market,
            this.openingBtcPrice ?? undefined,
          );
        } catch (error) {
          logger.error({ error }, "Failed to ensure market interval");
        }
      },
      onStateUpdate: () => {
        noteMarketDataMessage();
        this.onMarketData();
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
      this.recordSnapshotQueued();
    }, env.SNAPSHOT_INTERVAL_MS);

    this.settlementTimer = setInterval(() => {
      void this.settlementRecorder
        .settleClosedIntervals()
        .then((settledCount) => {
          if (settledCount > 0) {
            return this.adaptiveModel.refit();
          }
        })
        .catch((error) => {
          logger.error({ error }, "Settlement/refit cycle failed");
        });
    }, 30_000);

    this.onMarketData();
  }

  async stop(): Promise<void> {
    this.priceFeed.stop();
    this.kalshi.stop();
    this.retention.stop();
    await this.scheduler.stop();
    if (this.printTimer) clearInterval(this.printTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.settlementTimer) clearInterval(this.settlementTimer);
    await closeDb();
  }

  /** Hot path: never await DB or Monte Carlo. */
  private onMarketData(): void {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const ctx = this.collectContext();
      if (!ctx) return;

      this.scheduler.onMarketUpdate({
        marketId: ctx.market.ticker,
        currentPrice: ctx.features.currentPrice,
        strike: ctx.threshold,
        secondsRemaining: ctx.secondsRemaining,
        volatility: ctx.volPerSqrtSecond,
        drift: ctx.trend.driftDollarsPerSecond,
        yesMid: (ctx.kalshiState.yesBid + ctx.kalshiState.yesAsk) / 2,
        noMid: (ctx.kalshiState.noBid + ctx.kalshiState.noAsk) / 2,
        observedSettlementPrices: ctx.observedSettlementPrices,
      });

      updateLiveState({
        marketState: ctx.marketState,
        recommendation: this.livePrediction?.recommendation ?? null,
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  private runAnalytical(_reason: string): void {
    const ctx = this.collectContext();
    if (!ctx) return;

    const env = getEnv();
    const adaptiveParams = this.adaptiveModel.getParams();
    const probabilityInput = {
      currentPrice: ctx.features.currentPrice,
      threshold: ctx.threshold,
      secondsRemaining: ctx.secondsRemaining,
      volatilityPerSqrtSecond: ctx.volPerSqrtSecond,
      driftPerSecond: ctx.trend.driftDollarsPerSecond,
    };
    const probabilityOptions = { calibration: adaptiveParams.calibration };
    const probability = calculateBaselineProbability(
      probabilityInput,
      probabilityOptions,
    );

    // Prefer Monte Carlo probability when a fresh result exists for this market.
    const isSameTicker = this.livePrediction?.ticker === ctx.market.ticker;
    const mcProb = isSameTicker
      ? this.livePrediction!.monteCarloHighProbability
      : null;
    const highProbability = mcProb ?? probability.adjustedHighProbability;

    // Uncertainty is derived by re-pricing at perturbed volatility and drift, so
    // the decision layer knows how much to trust the edge it is handed.
    const uncertainty = estimateProbabilityUncertainty(
      {
        ...probabilityInput,
        pointEstimate: highProbability,
        monteCarloPathCount:
          mcProb != null && isSameTicker
            ? this.livePrediction!.simulationPathCount
            : null,
        volRelativeError: env.VOL_RELATIVE_ERROR,
        driftUncertaintyShare: env.DRIFT_UNCERTAINTY_SHARE,
        modelErrorFloor: env.MODEL_ERROR_FLOOR,
      },
      probabilityOptions,
    );

    const decision = makeDecision({
      highProbability,
      probabilityStdError: uncertainty.standardError,
      yesBid: ctx.kalshiState.yesBid,
      yesAsk: ctx.kalshiState.yesAsk,
      noBid: ctx.kalshiState.noBid,
      noAsk: ctx.kalshiState.noAsk,
      yesLiquidity: ctx.kalshiState.yesLiquidity,
      noLiquidity: ctx.kalshiState.noLiquidity,
      secondsRemaining: ctx.secondsRemaining,
      dataIsStale: ctx.dataIsStale,
      distanceToThresholdBps: ctx.features.distanceToThresholdBps,
      tradeImbalance: ctx.features.tradeImbalance,
      momentum30s: ctx.features.returns["return_30000ms_bps"] ?? null,
      momentum3m: ctx.features.returns["return_180000ms_bps"] ?? null,
    });

    const recommendation = buildBetRecommendation({
      marketTicker: ctx.market.ticker,
      timestamp: Date.now(),
      threshold: ctx.threshold,
      btcPrice: ctx.features.currentPrice,
      secondsRemaining: ctx.secondsRemaining,
      highProbability,
      probabilityStdError: uncertainty.standardError,
      yesAsk: ctx.kalshiState.yesAsk,
      noAsk: ctx.kalshiState.noAsk,
      decision,
    });

    let paperTrade: PaperTradeResult | null = null;
    if (
      this.paperTradePlacedForTicker !== ctx.market.ticker &&
      recommendation.tradeRecommendation !== "NO_BET"
    ) {
      paperTrade = this.paperTrader.maybeCreateTrade({ recommendation });
      if (paperTrade) {
        this.paperTradePlacedForTicker = ctx.market.ticker;
      }
    }

    this.livePrediction = {
      ticker: ctx.market.ticker,
      market: ctx.market,
      probability,
      recommendation,
      monteCarloHighProbability: mcProb,
      estimatedSettlementPrice:
        this.livePrediction?.ticker === ctx.market.ticker
          ? this.livePrediction.estimatedSettlementPrice
          : null,
      simulationPathCount:
        this.livePrediction?.ticker === ctx.market.ticker
          ? this.livePrediction.simulationPathCount
          : null,
      simulationDurationMs:
        this.livePrediction?.ticker === ctx.market.ticker
          ? this.livePrediction.simulationDurationMs
          : null,
      inputVersion: this.scheduler.getLatestInputVersion(),
      modelParamsId: adaptiveParams.paramsId,
      paperTrade,
    };

    updateLiveState({
      marketState: ctx.marketState,
      recommendation,
    });

    this.maybePersist(this.livePrediction, paperTrade);

    logger.debug(
      {
        ticker: ctx.market.ticker,
        direction: recommendation.predictedDirection,
        trade: recommendation.tradeRecommendation,
        strength: recommendation.strength,
        highProbability: highProbability.toFixed(3),
        stdError: uncertainty.standardError.toFixed(3),
        bestEdge: recommendation.bestEdge.toFixed(3),
        edgeCertainty: recommendation.edgeCertainty.toFixed(2),
        stake: recommendation.stakeFraction.toFixed(4),
        blockers: recommendation.blockers,
        mc: mcProb?.toFixed(3) ?? null,
        secondsRemaining: ctx.secondsRemaining,
      },
      "Analytical prediction updated",
    );
  }

  private applyMonteCarloResult(result: PredictionJobResult): void {
    if (result.stale) return;

    if (this.livePrediction && this.livePrediction.ticker === result.marketId) {
      this.livePrediction = {
        ...this.livePrediction,
        monteCarloHighProbability: result.highProbability,
        estimatedSettlementPrice: result.estimatedSettlementAverage,
        simulationPathCount: result.pathCount,
        simulationDurationMs: result.durationMs,
        inputVersion: result.inputVersion,
      };
    } else if (this.livePrediction) {
      this.livePrediction = {
        ...this.livePrediction,
        monteCarloHighProbability: result.highProbability,
        estimatedSettlementPrice: result.estimatedSettlementAverage,
        simulationPathCount: result.pathCount,
        simulationDurationMs: result.durationMs,
        inputVersion: result.inputVersion,
      };
    }

    // Recompute decision with MC probability on the main thread (cheap).
    this.runAnalytical("monte_carlo");

    const m = this.scheduler.getPool().getMetrics();
    updateWorkerMetrics({
      state: m.state,
      restartCount: m.restartCount,
      pendingJobs: m.pendingJobs,
      completedJobs: m.completedJobs,
      timedOutJobs: m.timedOutJobs,
      lastDurationMs: m.lastDurationMs,
      lastError: m.lastError,
    });
  }

  private maybePersist(
    live: LivePrediction,
    newPaperTrade: PaperTradeResult | null,
  ): void {
    const env = getEnv();
    const now = Date.now();
    const tradeChanged =
      live.recommendation.tradeRecommendation !== this.lastPersistedTrade;
    const due = now - this.lastPersistedAt >= env.PREDICTION_PERSIST_INTERVAL_MS;

    if (!due && !tradeChanged && !newPaperTrade) return;

    this.lastPersistedAt = now;
    this.lastPersistedTrade = live.recommendation.tradeRecommendation;

    const modelVersion = live.monteCarloHighProbability != null
      ? `${BASELINE_MODEL.name}@${BASELINE_MODEL.version}+mc`
      : `${BASELINE_MODEL.name}@${BASELINE_MODEL.version}`;

    this.recorder.enqueuePrediction({
      market: live.market,
      openingBtcPrice: this.openingBtcPrice ?? undefined,
      probability: live.probability,
      recommendation: live.recommendation,
      paperTrade: newPaperTrade,
      modelParamsId: live.modelParamsId,
      inputVersion: live.inputVersion,
      inputTimestamp: live.recommendation.timestamp,
      monteCarloHighProbability: live.monteCarloHighProbability,
      estimatedSettlementPrice: live.estimatedSettlementPrice,
      simulationPathCount: live.simulationPathCount,
      simulationDurationMs: live.simulationDurationMs,
      modelVersion,
    });
  }

  private collectContext(): {
    market: KalshiMarket;
    kalshiState: NonNullable<ReturnType<KalshiMarketService["getState"]>>;
    features: ReturnType<FeatureEngine["computeFeatures"]>;
    threshold: number;
    secondsRemaining: number;
    dataIsStale: boolean;
    volPerSqrtSecond: number;
    trend: ReturnType<typeof estimateTrend>;
    observedSettlementPrices: number[];
    marketState: ReturnType<typeof buildPredictionMarketState>;
  } | null {
    const market = this.kalshi.getCurrentMarket();
    const kalshiState = this.kalshi.getState();
    const spotState = this.priceFeed.getState();

    if (!market || !kalshiState || spotState.lastPrice <= 0) {
      return null;
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

    const observedSettlementPrices = this.featureEngine.getSettlementWindowPrices(
      market.closeTime.getTime(),
      env.MONTE_CARLO_SETTLEMENT_WINDOW_SECONDS,
    );

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

    return {
      market,
      kalshiState,
      features,
      threshold,
      secondsRemaining,
      dataIsStale,
      volPerSqrtSecond,
      trend,
      observedSettlementPrices,
      marketState,
    };
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

    const live = this.livePrediction;
    logger.info(
      {
        line: formatSnapshotLine(state),
        direction: live?.recommendation.predictedDirection ?? null,
        trade: live?.recommendation.tradeRecommendation ?? null,
        mc: live?.monteCarloHighProbability ?? null,
        worker: this.scheduler.getPool().getMetrics().state,
      },
      "Snapshot",
    );
  }

  private recordSnapshotQueued(): void {
    const ctx = this.collectContext();
    if (!ctx) return;

    if (this.lastRecordedSecond === ctx.secondsRemaining) {
      return;
    }
    this.lastRecordedSecond = ctx.secondsRemaining;

    this.recorder.enqueueSnapshot({
      state: ctx.marketState,
      features: ctx.features,
      kalshiFeatures: {
        yesSpread: ctx.kalshiState.yesSpread,
        noSpread: ctx.kalshiState.noSpread,
        yesLiquidity: ctx.kalshiState.yesLiquidity,
        noLiquidity: ctx.kalshiState.noLiquidity,
      },
    });
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
