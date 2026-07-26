import { desc, eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDb, closeDb } from "../storage/database.js";
import { marketIntervals, predictions } from "../storage/schema.js";

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function main(): Promise<void> {
  const outputPath =
    process.argv[2] ?? `data/prediction-history-${Date.now()}.csv`;

  const db = getDb();
  const rows = await db
    .select({
      prediction: predictions,
      interval: marketIntervals,
    })
    .from(predictions)
    .innerJoin(
      marketIntervals,
      eq(marketIntervals.id, predictions.marketIntervalId),
    )
    .orderBy(desc(predictions.timestamp));

  const header = [
    "prediction_id",
    "timestamp",
    "kalshi_ticker",
    "threshold",
    "seconds_remaining",
    "recommendation",
    "predicted_high_probability",
    "raw_high_probability",
    "high_edge",
    "low_edge",
    "confidence",
    "final_result",
    "actual_high",
    "recommendation_correct",
    "brier_score",
    "model_version",
    "reasons",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    const reasons = (row.prediction.reasonCodes as { reasons?: string[] } | null)
      ?.reasons?.join(" | ");

    lines.push(
      [
        row.prediction.id,
        row.prediction.timestamp.toISOString(),
        row.interval.kalshiTicker,
        row.interval.threshold,
        row.prediction.secondsRemaining,
        row.prediction.recommendation,
        row.prediction.adjustedHighProbability,
        row.prediction.rawHighProbability,
        row.prediction.highEdge,
        row.prediction.lowEdge,
        row.prediction.confidence,
        row.prediction.finalResult ?? row.interval.finalResult,
        row.prediction.actualHigh,
        row.prediction.recommendationCorrect,
        row.prediction.brierScore,
        row.prediction.modelVersion,
        reasons,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${lines.join("\n")}\n`);

  const evaluated = rows.filter((r) => r.prediction.evaluatedAt != null).length;
  const actionable = rows.filter(
    (r) => r.prediction.recommendation !== "NO_BET",
  ).length;
  const correct = rows.filter(
    (r) => r.prediction.recommendationCorrect === 1,
  ).length;

  console.log(`Exported ${rows.length} predictions to ${outputPath}`);
  console.log(`Evaluated: ${evaluated}`);
  console.log(`Actionable signals (HIGH/LOW): ${actionable}`);
  console.log(`Correct actionable signals: ${correct}`);

  await closeDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
