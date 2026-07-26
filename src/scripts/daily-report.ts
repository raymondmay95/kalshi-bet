import { eq, gte, and, isNotNull } from "drizzle-orm";
import { getDb, closeDb } from "../storage/database.js";
import {
  marketIntervals,
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

  await closeDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
