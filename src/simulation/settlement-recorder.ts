import { eq, isNull } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { KalshiMarketService } from "../kalshi/market-discovery.js";
import { calculateSettlementPnl } from "./paper-trader.js";
import { getDb } from "../storage/database.js";
import {
  marketIntervals,
  paperTrades,
  predictions,
} from "../storage/schema.js";

export class SettlementRecorder {
  constructor(private readonly kalshiService: KalshiMarketService) {}

  async settleClosedIntervals(): Promise<void> {
    const db = getDb();
    const openIntervals = await db
      .select()
      .from(marketIntervals)
      .where(isNull(marketIntervals.finalResult));

    for (const interval of openIntervals) {
      if (interval.intervalEnd.getTime() > Date.now()) {
        continue;
      }

      const result = await this.kalshiService.fetchSettlementForClosedMarket(
        interval.kalshiTicker,
      );
      if (!result) {
        continue;
      }

      await db
        .update(marketIntervals)
        .set({ finalResult: result })
        .where(eq(marketIntervals.id, interval.id));

      const trades = await db
        .select({
          trade: paperTrades,
          prediction: predictions,
        })
        .from(paperTrades)
        .innerJoin(predictions, eq(paperTrades.predictionId, predictions.id))
        .where(eq(predictions.marketIntervalId, interval.id));

      for (const row of trades) {
        if (row.trade.profitLoss != null) continue;

        const side = row.trade.side as "HIGH" | "LOW";
        const pnl = calculateSettlementPnl({
          side,
          entryPrice: row.trade.entryPrice,
          quantity: row.trade.quantity,
          simulatedFees: row.trade.simulatedFees,
          finalResult: result,
        });

        await db
          .update(paperTrades)
          .set({
            settlementValue: pnl.settlementValue,
            profitLoss: pnl.profitLoss,
          })
          .where(eq(paperTrades.id, row.trade.id));
      }

      logger.info(
        { ticker: interval.kalshiTicker, result, trades: trades.length },
        "Settled market interval",
      );
    }
  }
}
