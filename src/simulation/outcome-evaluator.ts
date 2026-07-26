import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../storage/database.js";
import { predictions } from "../storage/schema.js";

export function evaluateRecommendation(
  recommendation: string,
  finalResult: "yes" | "no",
): boolean | null {
  if (recommendation === "HIGH") {
    return finalResult === "yes";
  }
  if (recommendation === "LOW") {
    return finalResult === "no";
  }
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
      row.recommendation,
      finalResult,
    );

    await db
      .update(predictions)
      .set({
        finalResult,
        actualHigh,
        recommendationCorrect:
          recommendationCorrect == null ? null : recommendationCorrect ? 1 : 0,
        brierScore: brierScore(row.adjustedHighProbability, actualHigh),
        evaluatedAt: new Date(),
      })
      .where(eq(predictions.id, row.id));
  }

  return rows.length;
}
