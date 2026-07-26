import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import { KalshiClient, discoverActiveMarket } from "./kalshi-client.js";
import {
  deriveAskFromBid,
  buildSettlementDefinition,
  type KalshiMarket,
  type KalshiMarketState,
} from "./kalshi-types.js";

export class KalshiMarketService {
  private client: KalshiClient;
  private pollTimer: NodeJS.Timeout | null = null;
  private currentMarket: KalshiMarket | null = null;
  private state: KalshiMarketState | null = null;
  private onMarketChange?: (market: KalshiMarket) => void;
  private onStateUpdate?: (state: KalshiMarketState) => void;

  constructor(client?: KalshiClient) {
    this.client = client ?? new KalshiClient();
  }

  async start(
    callbacks?: {
      onMarketChange?: (market: KalshiMarket) => void;
      onStateUpdate?: (state: KalshiMarketState) => void;
    },
  ): Promise<void> {
    this.onMarketChange = callbacks?.onMarketChange;
    this.onStateUpdate = callbacks?.onStateUpdate;
    await this.refreshMarket();
    this.startPolling();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getCurrentMarket(): KalshiMarket | null {
    return this.currentMarket;
  }

  getState(): KalshiMarketState | null {
    return this.state;
  }

  isStale(maxAgeMs: number): boolean {
    if (!this.state) return true;
    return Date.now() - this.state.updatedAt > maxAgeMs;
  }

  getSecondsRemaining(): number {
    if (!this.currentMarket) return 0;
    return Math.max(
      0,
      Math.floor((this.currentMarket.closeTime.getTime() - Date.now()) / 1000),
    );
  }

  async refreshMarket(): Promise<KalshiMarket | null> {
    const market = await discoverActiveMarket(this.client);
    if (!market) {
      return null;
    }

    if (!this.currentMarket || this.currentMarket.ticker !== market.ticker) {
      logger.info(
        {
          ticker: market.ticker,
          strike: market.floorStrike,
          closeTime: market.closeTime.toISOString(),
        },
        "Active Kalshi market changed",
      );
      this.currentMarket = market;
      this.onMarketChange?.(market);
    }

    await this.refreshOrderBook();
    return market;
  }

  async refreshOrderBook(): Promise<KalshiMarketState | null> {
    if (!this.currentMarket) return null;

    try {
      const orderbook = await this.client.getOrderBook(this.currentMarket.ticker);
      const yesBid =
        orderbook.yes[0]?.price ?? this.currentMarket.yesBid;
      const noBid = orderbook.no[0]?.price ?? this.currentMarket.noBid;
      const yesAsk =
        this.currentMarket.yesAsk > 0
          ? this.currentMarket.yesAsk
          : deriveAskFromBid(noBid);
      const noAsk =
        this.currentMarket.noAsk > 0
          ? this.currentMarket.noAsk
          : deriveAskFromBid(yesBid);

      const yesLiquidity = orderbook.yes.reduce((sum, l) => sum + l.quantity, 0);
      const noLiquidity = orderbook.no.reduce((sum, l) => sum + l.quantity, 0);

      this.state = {
        market: this.currentMarket,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        yesSpread: Math.max(0, yesAsk - yesBid),
        noSpread: Math.max(0, noAsk - noBid),
        yesLiquidity,
        noLiquidity,
        updatedAt: Date.now(),
      };

      this.onStateUpdate?.(this.state);
      return this.state;
    } catch (error) {
      logger.error({ error, ticker: this.currentMarket.ticker }, "Failed to refresh orderbook");
      return this.state;
    }
  }

  async fetchSettlementForClosedMarket(ticker: string): Promise<"yes" | "no" | null> {
    const market = await this.client.getSettledMarket(ticker);
    return market?.result ?? null;
  }

  getSettlementDefinition() {
    if (!this.currentMarket) return null;
    return buildSettlementDefinition(this.currentMarket);
  }

  private startPolling(): void {
    const interval = getEnv().KALSHI_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(async () => {
      const secondsRemaining = this.getSecondsRemaining();
      if (secondsRemaining <= 0) {
        await this.refreshMarket();
      } else {
        await this.refreshOrderBook();
      }
    }, interval);
  }
}
