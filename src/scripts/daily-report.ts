import { desc, eq, gte, and, isNotNull } from "drizzle-orm";
import { getDb, closeDb } from "../storage/database.js";
import {
  marketIntervals,
  modelParams,
  predictions,
  paperTrades,
} from "../storage/schema.js";

function brierScore(probability: number, outcome: number): number {
  return (probability - outcome) ** 2;
}

async function main(): Promise<void> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const settledPredictions = await db
    .select({
      prediction: predictions,
      interval: marketIntervals,
    })
    .from(predictions)
    .innerJoin(
      marketIntervals,
      eq(predictions.marketIntervalId, marketIntervals.id),
    )
    .where(
      and(
        gte(predictions.timestamp, since),
        isNotNull(marketIntervals.finalResult),
      ),
    );

  const trades = await db
    .select()
    .from(paperTrades)
    .where(gte(paperTrades.createdAt, since));

  const settledTrades = trades.filter((t) => t.profitLoss != null);
  const totalPnl = settledTrades.reduce((sum, t) => sum + (t.profitLoss ?? 0), 0);

  let brierSum = 0;
  for (const row of settledPredictions) {
    const outcome = row.interval.finalResult === "yes" ? 1 : 0;
    brierSum += brierScore(row.prediction.adjustedHighProbability, outcome);
  }
  const avgBrier =
    settledPredictions.length > 0 ? brierSum / settledPredictions.length : null;

  const highCount = settledPredictions.filter(
    (r) => r.prediction.recommendation === "HIGH",
  ).length;
  const lowCount = settledPredictions.filter(
    (r) => r.prediction.recommendation === "LOW",
  ).length;
  const noBetCount = settledPredictions.filter(
    (r) => r.prediction.recommendation === "NO_BET",
  ).length;

  console.log("=== Daily Performance Report ===");
  console.log(`Period: last 24 hours`);
  console.log(`Predictions: ${settledPredictions.length}`);
  console.log(`  HIGH: ${highCount}, LOW: ${lowCount}, NO_BET: ${noBetCount}`);
  console.log(`Paper trades: ${trades.length} (${settledTrades.length} settled)`);
  console.log(`Net P&L: $${totalPnl.toFixed(4)}`);
  console.log(
    `Average Brier score: ${avgBrier != null ? avgBrier.toFixed(4) : "N/A"}`,
  );

  await reportSettlementBasis();

  await closeDb();
}

/**
 * The basis to the settling BRTI average, and how many intervals it took. Until
 * this is fitted the engine is still using `MODEL_ERROR_FLOOR` as a stand-in,
 * so its absence is the more useful signal of the two.
 */
async function reportSettlementBasis(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(modelParams)
    .orderBy(desc(modelParams.id))
    .limit(1);
  const latest = rows[0];

  console.log("");
  console.log("=== Settlement basis (our feed vs the BRTI average) ===");

  if (!latest) {
    console.log("No fitted parameters yet.");
    return;
  }

  if (latest.basisStdDev == null) {
    const metrics = latest.metricsJson as
      | { settlementBasis?: { minIntervals?: number } }
      | null;
    const minIntervals = metrics?.settlementBasis?.minIntervals;
    console.log(
      `Not measured yet — MODEL_ERROR_FLOOR is still standing in for it.${
        minIntervals != null ? ` Needs ${minIntervals}+ settled intervals.` : ""
      }`,
    );
    return;
  }

  const metrics = latest.metricsJson as
    | {
        settlementBasis?: {
          intervals?: number;
          informativeIntervals?: number;
          validationLogLoss?: number;
          baselineLogLoss?: number;
        };
      }
    | null;
  const basis = metrics?.settlementBasis;

  console.log(`Systematic offset: $${(latest.basisOffset ?? 0).toFixed(2)}`);
  console.log(`Interval-to-interval std dev: $${latest.basisStdDev.toFixed(2)}`);
  if (basis?.intervals != null) {
    console.log(
      `Fitted on ${basis.intervals} settled intervals, ${basis.informativeIntervals ?? "?"} of them near the strike`,
    );
  }
  if (basis?.validationLogLoss != null && basis?.baselineLogLoss != null) {
    console.log(
      `Held-out log loss ${basis.validationLogLoss.toFixed(4)} vs fallback ${basis.baselineLogLoss.toFixed(4)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
