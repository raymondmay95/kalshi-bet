import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import type { PredictionJob, PredictionJobResult } from "./job-types.js";
import {
  noteAnalyticalPrediction,
  noteMonteCarloComplete,
  noteMonteCarloRequest,
  noteStaleJobDiscarded,
  updateWorkerMetrics,
} from "./observability.js";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

export interface AnalyticalSnapshot {
  marketId: string;
  currentPrice: number;
  strike: number;
  secondsRemaining: number;
  volatility: number;
  drift: number;
  yesMid: number;
  noMid: number;
  observedSettlementPrices: number[];
  /**
   * Measured basis to the settling BRTI average, in dollars. Omitted until the
   * adaptive model has fitted one, in which case the simulation treats our feed
   * as settling the market exactly.
   */
  basisOffset?: number;
  basisStdDev?: number;
}

export interface SchedulerCallbacks {
  onAnalyticalDue: (reason: string) => void;
  onMonteCarloResult: (result: PredictionJobResult) => void;
}

/**
 * Schedules lightweight analytical refreshes and settlement Monte Carlo jobs.
 * Never runs Monte Carlo on the main thread — only submits to the worker pool.
 */
export class PredictionScheduler {
  private readonly pool: SimulationWorkerPool;
  private analyticalTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private inputVersion = 0;
  private lastAnalyticalAt = 0;
  private lastMonteCarloAt = 0;
  private lastSnapshot: AnalyticalSnapshot | null = null;
  private crossedThresholds = new Set<number>();
  private callbacks: SchedulerCallbacks | null = null;

  constructor(pool?: SimulationWorkerPool) {
    const env = getEnv();
    this.pool = pool ?? new SimulationWorkerPool({
      maxRuntimeMs: env.MONTE_CARLO_MAX_RUNTIME_MS,
    });
  }

  getPool(): SimulationWorkerPool {
    return this.pool;
  }

  start(callbacks: SchedulerCallbacks): void {
    this.callbacks = callbacks;
    const env = getEnv();

    this.pool.setResultHandler((result) => {
      if (result.stale) {
        noteStaleJobDiscarded();
        return;
      }
      noteMonteCarloComplete();
      this.callbacks?.onMonteCarloResult(result);
    });

    if (env.MONTE_CARLO_ENABLED) {
      this.pool.start();
    } else {
      logger.warn("Monte Carlo disabled via MONTE_CARLO_ENABLED=false");
    }

    this.analyticalTimer = setInterval(() => {
      this.callbacks?.onAnalyticalDue("interval");
    }, env.ANALYTICAL_PREDICTION_INTERVAL_MS);

    this.metricsTimer = setInterval(() => {
      const m = this.pool.getMetrics();
      updateWorkerMetrics({
        state: m.state,
        restartCount: m.restartCount,
        pendingJobs: m.pendingJobs,
        completedJobs: m.completedJobs,
        timedOutJobs: m.timedOutJobs,
        lastDurationMs: m.lastDurationMs,
        lastError: m.lastError,
      });
    }, 5_000);
  }

  async stop(): Promise<void> {
    if (this.analyticalTimer) clearInterval(this.analyticalTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.analyticalTimer = null;
    this.metricsTimer = null;
    await this.pool.stop();
  }

  /**
   * Ingest the latest market snapshot. Triggers analytical/MC work when
   * inputs change materially or cadence timers elapse.
   */
  onMarketUpdate(snapshot: AnalyticalSnapshot): void {
    const env = getEnv();
    const now = Date.now();
    const prev = this.lastSnapshot;
    this.lastSnapshot = snapshot;

    const material = isMaterialChange(prev, snapshot, env);
    const thresholdCross = noteThresholdCross(
      this.crossedThresholds,
      snapshot.secondsRemaining,
      [
        env.MONTE_CARLO_ACTIVE_THRESHOLD_SECONDS,
        env.MONTE_CARLO_FINAL_THRESHOLD_SECONDS,
        env.MONTE_CARLO_SETTLEMENT_WINDOW_SECONDS,
      ],
    );

    if (prev?.marketId !== snapshot.marketId) {
      this.crossedThresholds.clear();
      this.lastAnalyticalAt = 0;
      this.lastMonteCarloAt = 0;
    }

    const analyticalDue =
      material ||
      thresholdCross ||
      now - this.lastAnalyticalAt >= env.ANALYTICAL_PREDICTION_INTERVAL_MS;

    if (analyticalDue) {
      this.lastAnalyticalAt = now;
      noteAnalyticalPrediction();
      this.callbacks?.onAnalyticalDue(
        material ? "material_change" : thresholdCross ? "threshold" : "interval",
      );
    }

    const mcInterval = monteCarloIntervalMs(snapshot.secondsRemaining, env);
    const mcDue =
      material ||
      thresholdCross ||
      now - this.lastMonteCarloAt >= mcInterval;

    if (mcDue && env.MONTE_CARLO_ENABLED) {
      this.requestMonteCarlo(snapshot, material || thresholdCross);
    }
  }

  /** Force an analytical tick (used by the interval timer). */
  forceAnalytical(): void {
    this.lastAnalyticalAt = Date.now();
    noteAnalyticalPrediction();
  }

  requestMonteCarlo(snapshot: AnalyticalSnapshot, immediate = false): void {
    const env = getEnv();
    if (!env.MONTE_CARLO_ENABLED) return;

    if (!this.pool.isAvailable()) {
      // Degrade gracefully — analytical path continues without MC.
      return;
    }

    const now = Date.now();
    if (!immediate) {
      const interval = monteCarloIntervalMs(snapshot.secondsRemaining, env);
      if (now - this.lastMonteCarloAt < interval * 0.5) {
        return;
      }
    }

    this.inputVersion += 1;
    this.lastMonteCarloAt = now;
    noteMonteCarloRequest();

    const pathCount = choosePathCount(snapshot.secondsRemaining, env);
    const job: PredictionJob = {
      jobId: `${snapshot.marketId}-${this.inputVersion}`,
      marketId: snapshot.marketId,
      inputVersion: this.inputVersion,
      generatedAt: now,
      currentPrice: snapshot.currentPrice,
      strike: snapshot.strike,
      secondsRemaining: snapshot.secondsRemaining,
      volatility: snapshot.volatility,
      drift: snapshot.drift,
      settlementWindowSeconds: env.MONTE_CARLO_SETTLEMENT_WINDOW_SECONDS,
      pathCount,
      seed: hashSeed(snapshot.marketId, this.inputVersion),
      shockDistribution: env.MONTE_CARLO_SHOCK_DISTRIBUTION,
      studentTDegreesOfFreedom: env.MONTE_CARLO_STUDENT_T_DF,
      observedSettlementPrices: snapshot.observedSettlementPrices,
      basisOffset: snapshot.basisOffset ?? 0,
      basisStdDev: snapshot.basisStdDev ?? 0,
    };

    const status = this.pool.submit(job);
    if (status === "rejected") {
      noteStaleJobDiscarded();
    }
  }

  getLatestInputVersion(): number {
    return this.inputVersion;
  }
}

export function monteCarloIntervalMs(
  secondsRemaining: number,
  env: ReturnType<typeof getEnv>,
): number {
  if (secondsRemaining <= env.MONTE_CARLO_FINAL_THRESHOLD_SECONDS) {
    return env.MONTE_CARLO_INTERVAL_FINAL_MS;
  }
  if (secondsRemaining <= env.MONTE_CARLO_ACTIVE_THRESHOLD_SECONDS) {
    return env.MONTE_CARLO_INTERVAL_ACTIVE_MS;
  }
  return env.MONTE_CARLO_INTERVAL_NORMAL_MS;
}

export function choosePathCount(
  secondsRemaining: number,
  env: ReturnType<typeof getEnv>,
): number {
  if (secondsRemaining <= env.MONTE_CARLO_FINAL_THRESHOLD_SECONDS) {
    return env.MONTE_CARLO_PATHS_FINAL;
  }
  if (secondsRemaining <= env.MONTE_CARLO_ACTIVE_THRESHOLD_SECONDS) {
    return env.MONTE_CARLO_PATHS_FREQUENT;
  }
  return env.MONTE_CARLO_PATHS_NORMAL;
}

function isMaterialChange(
  prev: AnalyticalSnapshot | null,
  next: AnalyticalSnapshot,
  env: ReturnType<typeof getEnv>,
): boolean {
  if (!prev) return true;
  if (prev.marketId !== next.marketId) return true;
  if (prev.strike !== next.strike) return true;

  if (prev.currentPrice > 0) {
    const bps =
      (Math.abs(next.currentPrice - prev.currentPrice) / prev.currentPrice) *
      10_000;
    if (bps >= env.ANALYTICAL_PRICE_CHANGE_BPS) return true;
  }

  if (Math.abs(next.yesMid - prev.yesMid) >= env.ANALYTICAL_BOOK_CHANGE) {
    return true;
  }
  if (Math.abs(next.noMid - prev.noMid) >= env.ANALYTICAL_BOOK_CHANGE) {
    return true;
  }

  // Volatility jump > 20%
  if (prev.volatility > 0) {
    const volChange = Math.abs(next.volatility - prev.volatility) / prev.volatility;
    if (volChange >= 0.2) return true;
  }

  return false;
}

function noteThresholdCross(
  seen: Set<number>,
  secondsRemaining: number,
  thresholds: number[],
): boolean {
  let crossed = false;
  for (const threshold of thresholds) {
    if (secondsRemaining <= threshold && !seen.has(threshold)) {
      seen.add(threshold);
      crossed = true;
    }
  }
  return crossed;
}

function hashSeed(marketId: string, version: number): number {
  let h = version >>> 0;
  for (let i = 0; i < marketId.length; i += 1) {
    h = Math.imul(h ^ marketId.charCodeAt(i), 0x9e3779b1);
  }
  return h >>> 0 || 1;
}
