import { request } from "undici";
import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import type { CandleRecord } from "./binance-types.js";

export async function fetchRecentCandles(
  symbol = "BTCUSDT",
  interval = "1m",
  limit = 60,
): Promise<CandleRecord[]> {
  const env = getEnv();
  const url = `${env.BINANCE_REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const { body, statusCode } = await request(url);
  if (statusCode !== 200) {
    throw new Error(`Binance REST error: ${statusCode}`);
  }

  const data = (await body.json()) as unknown[][];
  return data.map((row) => ({
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
}

export async function fetchTickerPrice(symbol = "BTCUSDT"): Promise<number> {
  const env = getEnv();
  const url = `${env.BINANCE_REST_BASE}/api/v3/ticker/price?symbol=${symbol}`;
  const { body, statusCode } = await request(url);
  if (statusCode !== 200) {
    throw new Error(`Binance ticker error: ${statusCode}`);
  }
  const data = (await body.json()) as { price: string };
  return Number(data.price);
}

export async function backfillCandles(
  onCandle: (candle: CandleRecord) => void,
): Promise<void> {
  try {
    const candles = await fetchRecentCandles();
    for (const candle of candles) {
      onCandle(candle);
    }
    logger.info({ count: candles.length }, "Backfilled Binance candles");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        "Failed to backfill Binance candles",
      );
    }
}
