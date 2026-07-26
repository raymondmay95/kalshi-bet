import { request } from "undici";
import { getEnv, KALSHI_SERIES_TICKER } from "../config/environment.js";
import { logger } from "../config/logger.js";
import {
  marketSchema,
  parseMarket,
  parseMarketsResponse,
  parseOrderBookResponse,
  type KalshiMarket,
  type KalshiOrderBook,
} from "./kalshi-types.js";

export class KalshiClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? getEnv().KALSHI_API_BASE;
  }

  async getOpenMarkets(seriesTicker = KALSHI_SERIES_TICKER): Promise<KalshiMarket[]> {
    const url = `${this.baseUrl}/markets?series_ticker=${seriesTicker}&status=open&limit=20`;
    return this.fetchMarkets(url);
  }

  async getMarket(ticker: string): Promise<KalshiMarket | null> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(ticker)}`;
    const { body, statusCode } = await request(url);
    if (statusCode === 404) return null;
    if (statusCode !== 200) {
      throw new Error(`Kalshi market fetch failed: ${statusCode}`);
    }
    const data = (await body.json()) as { market: unknown };
    return parseMarket(marketSchema.parse(data.market));
  }

  async getSettledMarket(ticker: string): Promise<KalshiMarket | null> {
    return this.getMarket(ticker);
  }

  async getOrderBook(ticker: string): Promise<KalshiOrderBook> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(ticker)}/orderbook`;
    const { body, statusCode } = await request(url);
    if (statusCode !== 200) {
      throw new Error(`Kalshi orderbook fetch failed: ${statusCode}`);
    }
    const data = await body.json();
    return parseOrderBookResponse(data);
  }

  async getSeries(seriesTicker = KALSHI_SERIES_TICKER): Promise<unknown> {
    const url = `${this.baseUrl}/series/${seriesTicker}`;
    const { body, statusCode } = await request(url);
    if (statusCode !== 200) {
      throw new Error(`Kalshi series fetch failed: ${statusCode}`);
    }
    return body.json();
  }

  private async fetchMarkets(url: string): Promise<KalshiMarket[]> {
    const { body, statusCode } = await request(url);
    if (statusCode !== 200) {
      throw new Error(`Kalshi markets fetch failed: ${statusCode}`);
    }
    const data = await body.json();
    return parseMarketsResponse(data);
  }
}

export async function discoverActiveMarket(
  client = new KalshiClient(),
): Promise<KalshiMarket | null> {
  const markets = await client.getOpenMarkets();
  if (markets.length === 0) {
    logger.warn("No open KXBTC15M markets found");
    return null;
  }

  const now = Date.now();
  const active = markets
    .filter((m) => m.closeTime.getTime() > now)
    .sort((a, b) => a.closeTime.getTime() - b.closeTime.getTime());

  return active[0] ?? null;
}
