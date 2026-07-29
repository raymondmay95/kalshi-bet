import { desc, isNotNull, sql } from "drizzle-orm";
import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import { getDb } from "../storage/database.js";
import { modelMetrics, modelParams, predictions } from "../storage/schema.js";
import { BASELINE_MODEL } from "./model-types.js";
import {
  fitSettlementBasis,
  type SettlementBasis,
  type SettlementBasisFit,
  type SettlementBasisSample,
} from "./settlement-basis.js";
import {
  DEFAULT_CONFIDENCE_MULTIPLIER,
  PROBABILITY_CAP,
  shrinkTowardHalfInLogOdds,
} from "./baseline-probability.js";
import {
  applyCalibration,
  fitPlattCalibration,
  fitVolScale,
  meanBrierScore,
  type CalibrationSample,
  type PlattCalibration,
  type VolScaleSample,
} from "./calibration.js";

export interface AdaptiveParams {
  paramsId: number | null;
  calibration: PlattCalibration | null;
  volScale: number;
  /**
   * Measured basis to the settling BRTI average, or null while the engine is
   * still relying on the fixed `MODEL_ERROR_FLOOR` to stand in for it.
   */
  settlementBasis: SettlementBasis | null;
}

const DEFAULT_PARAMS: AdaptiveParams = {
  paramsId: null,
  calibration: null,
  volScale: 1,
  settlementBasis: null,
};

// Learning gates: below these sample counts the fixed defaults stay active.
const MIN_CALIBRATION_SAMPLES = 100;
const MIN_VOL_SAMPLES = 30;
const MAX_HISTORY = 2000;
// Fraction of history used for fitting; the rest validates the fit.
const TRAIN_FRACTION = 0.8;

/**
 * Basis gates, far higher than the others because the fit is powered only by
 * intervals that settled near the strike, and those are a small minority — a
 * 15-minute BTC window typically ends hundreds of dollars from the strike, where
 * the outcome was never in doubt and says nothing about a basis worth a few
 * dollars.
 *
 * Simulated at a $300 window standard deviation and 96 windows a day: 500
 * intervals (about five days) pins a $20 basis to roughly +/-25%, while a $5
 * basis produces too few near-strike intervals to clear the informative gate
 * until around 2000 have settled. That is the intended behaviour — the gate
 * self-adjusts, waiting longer exactly when the basis is small enough that
 * mismeasuring it barely moves a probability.
 */
const MIN_BASIS_INTERVALS = 500;
const MIN_INFORMATIVE_BASIS_INTERVALS = 75;
/** Intervals considered per refit — roughly two months at 96 windows a day. */
const MAX_BASIS_INTERVALS = 5000;

/**
 * Learns from settled prediction history and serves the fitted parameters
 * to the prediction engine.
 *
 * Safety properties:
 * - Calibration is validated walk-forward (fit on older 80%, tested on the
 *   newest 20%) and only promoted when it beats the fixed default shrink
 *   on Brier score. Otherwise the engine keeps its defaults.
 * - The volatility scale is heavily clamped (0.5x to 2x) and requires a
 *   minimum sample count.
 * - Every promoted parameter set is persisted with its fit metrics, and
 *   predictions record which parameter set they used.
 */
export class AdaptiveModelService {
  private params: AdaptiveParams = DEFAULT_PARAMS;

  getParams(): AdaptiveParams {
    return this.params;
  }

  /** Load the most recent fitted parameters, then refit on current history. */
  async initialize(): Promise<void> {
    try {
      await this.loadLatest();
      await this.refit();
    } catch (error) {
      logger.warn(
        { error },
        "Adaptive model unavailable; using default parameters",
      );
    }
  }

  async loadLatest(): Promise<void> {
    const db = getDb();
    const rows = await db
      .select()
      .from(modelParams)
      .orderBy(desc(modelParams.id))
      .limit(1);
    const latest = rows[0];
    if (!latest) return;

    this.params = {
      paramsId: latest.id,
      calibration:
        latest.calibrationIntercept != null && latest.calibrationSlope != null
          ? {
              intercept: latest.calibrationIntercept,
              slope: latest.calibrationSlope,
            }
          : null,
      volScale: latest.volScale ?? 1,
      settlementBasis:
        latest.basisStdDev != null
          ? { offset: latest.basisOffset ?? 0, stdDev: latest.basisStdDev }
          : null,
    };
    logger.info(
      { paramsId: latest.id, ...describeParams(this.params) },
      "Loaded adaptive model parameters",
    );
  }

  async refit(): Promise<void> {
    const db = getDb();

    // Settled predictions, oldest first, most recent MAX_HISTORY.
    const settled = (
      await db
        .select()
        .from(predictions)
        .where(isNotNull(predictions.actualHigh))
        .orderBy(desc(predictions.timestamp))
        .limit(MAX_HISTORY)
    ).reverse();

    const calibrationResult = this.fitCalibrationWithValidation(settled);
    const volScale = await this.fitVolatilityScale(settled);
    const basisFit = await this.fitSettlementBasisFromHistory();

    if (!calibrationResult.calibration && volScale == null && !basisFit) {
      logger.info(
        { settledSamples: settled.length },
        "Not enough settled history to fit adaptive parameters yet",
      );
      return;
    }

    const inserted = await db
      .insert(modelParams)
      .values({
        sampleCount: settled.length,
        calibrationIntercept: calibrationResult.calibration?.intercept ?? null,
        calibrationSlope: calibrationResult.calibration?.slope ?? null,
        volScale,
        basisOffset: basisFit?.offset ?? null,
        basisStdDev: basisFit?.stdDev ?? null,
        metricsJson: {
          calibration: calibrationResult.metrics,
          volSampleMinimum: MIN_VOL_SAMPLES,
          settlementBasis: basisFit
            ? {
                offset: basisFit.offset,
                stdDev: basisFit.stdDev,
                intervals: basisFit.sampleCount,
                informativeIntervals: basisFit.informativeCount,
                validationLogLoss: basisFit.validationLogLoss,
                baselineLogLoss: basisFit.baselineLogLoss,
              }
            : { fitted: false, minIntervals: MIN_BASIS_INTERVALS },
        },
      })
      .returning({ id: modelParams.id });

    this.params = {
      paramsId: inserted[0]!.id,
      calibration: calibrationResult.calibration,
      volScale: volScale ?? 1,
      settlementBasis: basisFit
        ? { offset: basisFit.offset, stdDev: basisFit.stdDev }
        : null,
    };

    const periodStart = settled[0]?.timestamp ?? new Date();
    const periodEnd = settled[settled.length - 1]?.timestamp ?? new Date();
    const brier =
      typeof calibrationResult.metrics.fittedBrier === "number"
        ? calibrationResult.metrics.fittedBrier
        : null;

    await db.insert(modelMetrics).values({
      modelVersion: `${BASELINE_MODEL.name}@${BASELINE_MODEL.version}`,
      evaluationPeriodStart: periodStart,
      evaluationPeriodEnd: periodEnd,
      brierScore: brier,
      predictionCount: settled.length,
      tradeCount: 0,
      metricsJson: {
        calibration: calibrationResult.metrics,
        volScale: volScale ?? 1,
        paramsId: inserted[0]!.id,
      },
    });

    logger.info(
      {
        paramsId: inserted[0]!.id,
        sampleCount: settled.length,
        ...describeParams(this.params),
        metrics: calibrationResult.metrics,
      },
      "Refit adaptive model parameters",
    );
  }

  /**
   * Fit Platt calibration on the older portion of history and promote it
   * only if it beats the fixed default shrink on the held-out newest
   * portion. The promoted parameters are then refit on all samples.
   */
  private fitCalibrationWithValidation(
    settled: Array<{ rawHighProbability: number; actualHigh: number | null }>,
  ): {
    calibration: PlattCalibration | null;
    metrics: Record<string, number | boolean | null>;
  } {
    const samples: CalibrationSample[] = settled
      .filter((row) => row.actualHigh != null)
      .map((row) => ({
        rawProbability: row.rawHighProbability,
        outcome: row.actualHigh!,
      }));

    if (samples.length < MIN_CALIBRATION_SAMPLES) {
      return {
        calibration: null,
        metrics: { samples: samples.length, promoted: false },
      };
    }

    const splitIndex = Math.floor(samples.length * TRAIN_FRACTION);
    const train = samples.slice(0, splitIndex);
    const validation = samples.slice(splitIndex);

    const candidate = fitPlattCalibration(train, {
      minSamples: Math.floor(MIN_CALIBRATION_SAMPLES * TRAIN_FRACTION),
    });
    if (!candidate || validation.length === 0) {
      return {
        calibration: null,
        metrics: { samples: samples.length, promoted: false },
      };
    }

    const fittedBrier = meanBrierScore(
      validation.map((s) => ({
        probability: capProbability(applyCalibration(s.rawProbability, candidate)),
        outcome: s.outcome,
      })),
    );
    const baselineBrier = meanBrierScore(
      validation.map((s) => ({
        probability: capProbability(
          shrinkTowardHalfInLogOdds(
            s.rawProbability,
            DEFAULT_CONFIDENCE_MULTIPLIER,
          ),
        ),
        outcome: s.outcome,
      })),
    );

    const promoted = fittedBrier <= baselineBrier;
    const finalCalibration = promoted
      ? fitPlattCalibration(samples, { minSamples: MIN_CALIBRATION_SAMPLES })
      : null;

    return {
      calibration: finalCalibration,
      metrics: {
        samples: samples.length,
        validationSamples: validation.length,
        fittedBrier,
        baselineBrier,
        promoted: finalCalibration != null,
      },
    };
  }

  /**
   * Recover the basis to the settling BRTI average from settled outcomes.
   *
   * For every settled interval this rebuilds our own version of the settlement
   * statistic — the mean of our spot feed over the same final minute the BRTI
   * average covers — and pairs its distance from the strike with the binary
   * result. Intervals with too few recorded seconds in that window are dropped,
   * since a partial average is not the statistic being compared.
   */
  private async fitSettlementBasisFromHistory(): Promise<SettlementBasisFit | null> {
    const windowSeconds = getEnv().MONTE_CARLO_SETTLEMENT_WINDOW_SECONDS;
    // Half the window must be present for the average to be comparable.
    const minPointsInWindow = Math.max(2, Math.floor(windowSeconds / 2));

    const db = getDb();
    const rows = await db.execute(sql`
      SELECT
        mi.threshold AS threshold,
        mi.final_result AS final_result,
        AVG(ms.btc_price) AS our_average
      FROM market_intervals mi
      JOIN market_snapshots ms ON ms.market_interval_id = mi.id
      WHERE mi.final_result IS NOT NULL
        AND ms.seconds_remaining >= 0
        AND ms.seconds_remaining <= ${windowSeconds}
        AND ms.btc_price > 0
      GROUP BY mi.id, mi.threshold, mi.final_result, mi.interval_end
      HAVING COUNT(ms.id) >= ${minPointsInWindow}
      ORDER BY mi.interval_end DESC
      LIMIT ${MAX_BASIS_INTERVALS}
    `);

    const samples: SettlementBasisSample[] = [];
    for (const row of rows as unknown as Array<{
      threshold: number | string;
      final_result: string;
      our_average: number | string;
    }>) {
      const threshold = Number(row.threshold);
      const ourAverage = Number(row.our_average);
      if (!(threshold > 0) || !(ourAverage > 0)) continue;
      samples.push({
        distance: ourAverage - threshold,
        outcome: row.final_result === "yes" ? 1 : 0,
      });
    }

    // The query returns newest first; the walk-forward split needs oldest first.
    samples.reverse();

    const fit = fitSettlementBasis(samples, {
      minSamples: MIN_BASIS_INTERVALS,
      minInformativeSamples: MIN_INFORMATIVE_BASIS_INTERVALS,
      trainFraction: TRAIN_FRACTION,
    });

    if (!fit) {
      logger.info(
        {
          intervals: samples.length,
          minIntervals: MIN_BASIS_INTERVALS,
          minInformative: MIN_INFORMATIVE_BASIS_INTERVALS,
        },
        "Settlement basis not fitted yet; MODEL_ERROR_FLOOR still stands in for it",
      );
    }

    return fit;
  }

  /**
   * Compare each prediction's expected standard deviation with the realized
   * move from lock price to the interval's last recorded snapshot price.
   */
  private async fitVolatilityScale(
    settled: Array<{
      marketIntervalId: number;
      btcPrice: number | null;
      remainingStdDev: number | null;
      appliedDrift: number | null;
    }>,
  ): Promise<number | null> {
    const usable = settled.filter(
      (row) => row.btcPrice != null && row.remainingStdDev != null,
    );
    if (usable.length < MIN_VOL_SAMPLES) return null;

    const db = getDb();
    const intervalIds = [...new Set(usable.map((row) => row.marketIntervalId))];
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (market_interval_id)
        market_interval_id AS interval_id,
        btc_price
      FROM market_snapshots
      WHERE market_interval_id = ANY(${intervalIds})
      ORDER BY market_interval_id, timestamp DESC
    `);

    const settlePriceByInterval = new Map<number, number>();
    for (const row of rows as unknown as Array<{
      interval_id: number;
      btc_price: number;
    }>) {
      settlePriceByInterval.set(Number(row.interval_id), Number(row.btc_price));
    }

    const samples: VolScaleSample[] = [];
    for (const row of usable) {
      const settlePrice = settlePriceByInterval.get(row.marketIntervalId);
      if (settlePrice == null || settlePrice <= 0) continue;
      samples.push({
        predictedStdDev: row.remainingStdDev!,
        realizedMove:
          settlePrice - row.btcPrice! - (row.appliedDrift ?? 0),
      });
    }

    return fitVolScale(samples, { minSamples: MIN_VOL_SAMPLES });
  }
}

function capProbability(p: number): number {
  return Math.max(1 - PROBABILITY_CAP, Math.min(PROBABILITY_CAP, p));
}

function describeParams(params: AdaptiveParams): Record<string, number | null> {
  return {
    calibrationIntercept: params.calibration?.intercept ?? null,
    calibrationSlope: params.calibration?.slope ?? null,
    volScale: params.volScale,
    basisOffset: params.settlementBasis?.offset ?? null,
    basisStdDev: params.settlementBasis?.stdDev ?? null,
  };
}
