import type { CandleRecord } from "../binance/binance-types.js";
import { backfillCandles as backfillBinanceCandles } from "../binance/binance-client.js";
import { BinanceFeedService, type BinanceFeedCallbacks } from "../binance/binance-feed.js";
import type { BinanceMarketState } from "../binance/binance-types.js";
import { backfillCandles as backfillCoinbaseCandles } from "../coinbase/coinbase-client.js";
import { CoinbaseFeedService } from "../coinbase/coinbase-feed.js";
import { getEnv } from "../config/environment.js";

export interface SpotFeedService {
  start(): void;
  stop(): void;
  getState(): BinanceMarketState;
  isStale(maxAgeMs: number): boolean;
}

export function createPriceFeed(callbacks: BinanceFeedCallbacks = {}): SpotFeedService {
  const feed = getEnv().PRICE_FEED;
  if (feed === "coinbase") {
    return new CoinbaseFeedService(getEnv().COINBASE_PRODUCT_ID, callbacks);
  }
  return new BinanceFeedService(callbacks);
}

export async function backfillPriceCandles(
  onCandle: (candle: CandleRecord) => void,
): Promise<void> {
  const env = getEnv();
  if (env.PRICE_FEED === "coinbase") {
    await backfillCoinbaseCandles(onCandle, env.COINBASE_PRODUCT_ID);
    return;
  }
  await backfillBinanceCandles(onCandle);
}
