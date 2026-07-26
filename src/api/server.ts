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
  paperTrades,
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
  const port = getEnv().API_PORT;

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
        const trades = await db
          .select()
          .from(paperTrades)
          .orderBy(desc(paperTrades.createdAt))
          .limit(200);

        const settled = trades.filter((t) => t.profitLoss != null);
        const totalPnl = settled.reduce((sum, t) => sum + (t.profitLoss ?? 0), 0);

        res.writeHead(200);
        res.end(
          JSON.stringify({
            totalTrades: trades.length,
            settledTrades: settled.length,
            totalPnl,
            trades,
          }),
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

  server.listen(port, () => {
    logger.info({ port }, "API server listening");
  });
}
