import { and, isNotNull, lt } from "drizzle-orm";
import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import { getDb } from "./database.js";
import { marketSnapshots, predictions } from "./schema.js";

export interface RetentionResult {
  snapshotsDeleted: number;
  predictionsDeleted: number;
}

/**
 * Deletes aged snapshot/prediction rows per retention settings.
 * Never deletes rows newer than the configured retention windows.
 * Unevaluated predictions are always kept.
 */
export async function runRetentionCleanup(
  now = new Date(),
): Promise<RetentionResult> {
  const env = getEnv();
  const db = getDb();

  const snapshotCutoff = daysAgo(now, env.ONE_SECOND_BAR_RETENTION_DAYS);
  const predictionCutoff = daysAgo(now, env.PREDICTION_RETENTION_DAYS);

  let snapshotsDeleted = 0;
  let predictionsDeleted = 0;

  if (env.ONE_SECOND_BAR_RETENTION_DAYS > 0) {
    const deleted = await db
      .delete(marketSnapshots)
      .where(lt(marketSnapshots.timestamp, snapshotCutoff))
      .returning({ id: marketSnapshots.id });
    snapshotsDeleted = deleted.length;
  }

  if (env.PREDICTION_RETENTION_DAYS > 0) {
    const deleted = await db
      .delete(predictions)
      .where(
        and(
          lt(predictions.timestamp, predictionCutoff),
          isNotNull(predictions.evaluatedAt),
        ),
      )
      .returning({ id: predictions.id });
    predictionsDeleted = deleted.length;
  }

  // RAW_TICK_RETENTION_DAYS is reserved for a future raw-tick table.
  // market_snapshots currently serve as 1-second bars.
  void env.RAW_TICK_RETENTION_DAYS;

  logger.info(
    {
      snapshotsDeleted,
      predictionsDeleted,
      snapshotCutoff: snapshotCutoff.toISOString(),
      predictionCutoff: predictionCutoff.toISOString(),
    },
    "Retention cleanup completed",
  );

  return { snapshotsDeleted, predictionsDeleted };
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export class RetentionService {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;

  start(): void {
    const env = getEnv();
    const initialDelay = Math.min(env.RETENTION_CLEANUP_INTERVAL_MS, 60_000);
    this.initialTimer = setTimeout(() => {
      void runRetentionCleanup().catch((error) => {
        logger.error({ error }, "Retention cleanup failed");
      });
    }, initialDelay);

    this.timer = setInterval(() => {
      void runRetentionCleanup().catch((error) => {
        logger.error({ error }, "Retention cleanup failed");
      });
    }, env.RETENTION_CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
  }
}
