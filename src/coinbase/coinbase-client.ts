import { request } from "undici";
import { logger } from "../config/logger.js";
import type { CandleRecord } from "../binance/binance-types.js";

const COINBASE_REST = "https://api.exchange.coinbase.com";

export async function fetchRecentCandles(
  productId = "BTC-USD",
  granularity = 60,
  limit = 60,
): Promise<CandleRecord[]> {
  const url = `${COINBASE_REST}/products/${productId}/candles?granularity=${granularity}`;
  const { body, statusCode } = await request(url);
  if (statusCode !== 200) {
    throw new Error(`Coinbase REST error: ${statusCode}`);
  }

  const data = (await body.json()) as number[][];
  return data
    .slice(0, limit)
    .map((row) => ({
      timestamp: row[0]! * 1000,
      open: row[3]!,
      high: row[2]!,
      low: row[1]!,
      close: row[4]!,
      volume: row[5]!,
    }))
    .reverse();
}

export async function backfillCandles(
  onCandle: (candle: CandleRecord) => void,
  productId = "BTC-USD",
): Promise<void> {
  try {
    const candles = await fetchRecentCandles(productId);
    for (const candle of candles) {
      onCandle(candle);
    }
    logger.info({ count: candles.length, productId }, "Backfilled Coinbase candles");
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : error },
      "Failed to backfill Coinbase candles",
    );
  }
}
