import { createServer } from "node:http";
import { eq, desc } from "drizzle-orm";
import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import type { BetRecommendation } from "../decision/decision-engine.js";
import type { PredictionMarketState } from "../market/market-state.js";
import { getDb } from "../storage/database.js";
import {
  marketIntervals,
  predictions,
} from "../storage/schema.js";

export interface LiveState {
  marketState: PredictionMarketState | null;
  recommendation: BetRecommendation | null;
  updatedAt: number;
}

let liveState: LiveState = {
  marketState: null,
  recommendation: null,
  updatedAt: 0,
};

export function updateLiveState(state: Partial<LiveState>): void {
  liveState = {
    ...liveState,
    ...state,
    updatedAt: Date.now(),
  };
}

export function getLiveState(): LiveState {
  return liveState;
}

export function startApiServer(): void {
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    try {
      if (req.url === "/health") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url === "/api/live") {
        res.writeHead(200);
        res.end(JSON.stringify(getLiveState()));
        return;
      }

      if (req.url === "/api/predictions") {
        const db = getDb();
        const rows = await db
          .select()
          .from(predictions)
          .orderBy(desc(predictions.timestamp))
          .limit(50);
        res.writeHead(200);
        res.end(JSON.stringify(rows));
        return;
      }

      if (req.url === "/api/performance") {
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
          .orderBy(desc(predictions.timestamp))
          .limit(500);

        const evaluated = rows.filter((r) => r.prediction.evaluatedAt != null);
        const actionable = evaluated.filter(
          (r) => r.prediction.recommendation !== "NO_BET",
        );
        const correct = actionable.filter(
          (r) => r.prediction.recommendationCorrect === 1,
        );
        const avgBrier =
          evaluated.length > 0
            ? evaluated.reduce(
                (sum, r) => sum + (r.prediction.brierScore ?? 0),
                0,
              ) / evaluated.length
            : null;

        res.writeHead(200);
        res.end(
          JSON.stringify({
            totalPredictions: rows.length,
            evaluatedPredictions: evaluated.length,
            actionableSignals: actionable.length,
            correctSignals: correct.length,
            accuracy:
              actionable.length > 0
                ? correct.length / actionable.length
                : null,
            averageBrier: avgBrier,
          }),
        );
        return;
      }

      if (req.url === "/api/history") {
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
          .orderBy(desc(predictions.timestamp))
          .limit(100);

        res.writeHead(200);
        res.end(
          JSON.stringify(
            rows.map((row) => ({
              id: row.prediction.id,
              timestamp: row.prediction.timestamp,
              ticker: row.interval.kalshiTicker,
              threshold: row.interval.threshold,
              secondsRemaining: row.prediction.secondsRemaining,
              recommendation: row.prediction.recommendation,
              predictedHigh: row.prediction.adjustedHighProbability,
              confidence: row.prediction.confidence,
              finalResult: row.prediction.finalResult ?? row.interval.finalResult,
              actualHigh: row.prediction.actualHigh,
              correct:
                row.prediction.recommendationCorrect == null
                  ? null
                  : row.prediction.recommendationCorrect === 1,
              brierScore: row.prediction.brierScore,
              reasons: (row.prediction.reasonCodes as { reasons?: string[] } | null)
                ?.reasons,
            })),
          ),
        );
        return;
      }

      if (req.url === "/api/intervals") {
        const db = getDb();
        const rows = await db
          .select()
          .from(marketIntervals)
          .orderBy(desc(marketIntervals.intervalEnd))
          .limit(20);
        res.writeHead(200);
        res.end(JSON.stringify(rows));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      logger.error({ error }, "API error");
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(getEnv().API_PORT, getEnv().API_HOST, () => {
    logger.info(
      { port: getEnv().API_PORT, host: getEnv().API_HOST },
      "API server listening",
    );
  });
}
