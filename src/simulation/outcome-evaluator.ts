import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../storage/database.js";
import { predictions } from "../storage/schema.js";

export function evaluateRecommendation(
  recommendation: string,
  finalResult: "yes" | "no",
): boolean | null {
  if (recommendation === "HIGH" || recommendation === "BET_HIGH") {
    return finalResult === "yes";
  }
  if (recommendation === "LOW" || recommendation === "BET_LOW") {
    return finalResult === "no";
  }
  return null;
}

export function evaluateDirection(
  predictedDirection: string | null | undefined,
  finalResult: "yes" | "no",
): boolean | null {
  if (predictedDirection === "HIGH") return finalResult === "yes";
  if (predictedDirection === "LOW") return finalResult === "no";
  return null;
}

export function brierScore(probability: number, actualHigh: number): number {
  return (probability - actualHigh) ** 2;
}

export async function evaluatePredictionsForInterval(
  intervalId: number,
  finalResult: "yes" | "no",
): Promise<number> {
  const db = getDb();
  const actualHigh = finalResult === "yes" ? 1 : 0;
  const rows = await db
    .select()
    .from(predictions)
    .where(
      and(
        eq(predictions.marketIntervalId, intervalId),
        isNull(predictions.evaluatedAt),
      ),
    );

  for (const row of rows) {
    const recommendationCorrect = evaluateRecommendation(
      row.tradeRecommendation ?? row.recommendation,
      finalResult,
    );
    const directionCorrect = evaluateDirection(
      row.predictedDirection,
      finalResult,
    );

    await db
      .update(predictions)
      .set({
        finalResult,
        actualHigh,
        recommendationCorrect:
          recommendationCorrect == null ? null : recommendationCorrect ? 1 : 0,
        directionCorrect:
          directionCorrect == null ? null : directionCorrect ? 1 : 0,
        brierScore: brierScore(
          row.calibratedHighProbability ?? row.adjustedHighProbability,
          actualHigh,
        ),
        evaluatedAt: new Date(),
      })
      .where(eq(predictions.id, row.id));
  }

  return rows.length;
}
