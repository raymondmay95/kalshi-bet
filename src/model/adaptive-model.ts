import { desc, isNotNull, sql } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { getDb } from "../storage/database.js";
import { modelMetrics, modelParams, predictions } from "../storage/schema.js";
import { BASELINE_MODEL } from "./model-types.js";
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
}

const DEFAULT_PARAMS: AdaptiveParams = {
  paramsId: null,
  calibration: null,
  volScale: 1,
};

// Learning gates: below these sample counts the fixed defaults stay active.
const MIN_CALIBRATION_SAMPLES = 100;
const MIN_VOL_SAMPLES = 30;
const MAX_HISTORY = 2000;
// Fraction of history used for fitting; the rest validates the fit.
const TRAIN_FRACTION = 0.8;

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

    if (!calibrationResult.calibration && volScale == null) {
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
        metricsJson: {
          calibration: calibrationResult.metrics,
          volSampleMinimum: MIN_VOL_SAMPLES,
        },
      })
      .returning({ id: modelParams.id });

    this.params = {
      paramsId: inserted[0]!.id,
      calibration: calibrationResult.calibration,
      volScale: volScale ?? 1,
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
  };
}
