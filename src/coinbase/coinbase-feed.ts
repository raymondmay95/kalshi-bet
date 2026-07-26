import WebSocket from "ws";
import { logger } from "../config/logger.js";
import type {
  BinanceMarketState,
  CandleRecord,
  TradeRecord,
} from "../binance/binance-types.js";

export interface CoinbaseFeedCallbacks {
  onTrade?: (trade: TradeRecord) => void;
  onState?: (state: BinanceMarketState) => void;
  onCandle?: (candle: CandleRecord) => void;
  onReconnect?: () => void;
}

interface CoinbaseMatch {
  type: "match" | "last_match";
  product_id: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  time: string;
}

interface CoinbaseTicker {
  type: "ticker";
  product_id: string;
  price: string;
  best_bid: string;
  best_ask: string;
  time: string;
}

export class CoinbaseFeedService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly productId: string;

  private state: BinanceMarketState = {
    symbol: "BTC-USD",
    lastPrice: 0,
    bid: 0,
    ask: 0,
    bidQty: 0,
    askQty: 0,
    lastTradeTime: 0,
    updatedAt: 0,
    bidDepth: 0,
    askDepth: 0,
    microprice: 0,
    buyVolume: 0,
    sellVolume: 0,
    tradeCount: 0,
  };

  constructor(
    productId = "BTC-USD",
    private readonly callbacks: CoinbaseFeedCallbacks = {},
  ) {
    this.productId = productId;
    this.state.symbol = productId;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  getState(): BinanceMarketState {
    return { ...this.state };
  }

  isStale(maxAgeMs: number): boolean {
    if (this.state.updatedAt === 0) return true;
    return Date.now() - this.state.updatedAt > maxAgeMs;
  }

  private connect(): void {
    const url = "wss://ws-feed.exchange.coinbase.com";
    logger.info({ url, productId: this.productId }, "Connecting to Coinbase WebSocket");

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.ws?.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [this.productId],
          channels: ["matches", "ticker"],
        }),
      );
      logger.info("Coinbase WebSocket connected");
    });

    this.ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as
          | CoinbaseMatch
          | CoinbaseTicker
          | { type: string };

        if (payload.type === "match" || payload.type === "last_match") {
          this.handleMatch(payload as CoinbaseMatch);
        } else if (payload.type === "ticker") {
          this.handleTicker(payload as CoinbaseTicker);
        }
      } catch (error) {
        logger.warn({ error }, "Failed to parse Coinbase message");
      }
    });

    this.ws.on("close", () => {
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (error) => {
      logger.error({ error }, "Coinbase WebSocket error");
    });
  }

  private handleMatch(match: CoinbaseMatch): void {
    const price = Number(match.price);
    const quantity = Number(match.size);
    const timestamp = Date.parse(match.time);

    this.state.lastPrice = price;
    this.state.lastTradeTime = timestamp;
    this.state.updatedAt = Date.now();
    this.state.tradeCount += 1;

    if (match.side === "buy") {
      this.state.buyVolume += quantity;
    } else {
      this.state.sellVolume += quantity;
    }

    this.updateMicroprice();
    this.callbacks.onTrade?.({
      price,
      quantity,
      timestamp,
      isBuyerMaker: match.side === "sell",
    });
    this.callbacks.onState?.(this.getState());
  }

  private handleTicker(ticker: CoinbaseTicker): void {
    const price = Number(ticker.price);
    const bid = Number(ticker.best_bid);
    const ask = Number(ticker.best_ask);

    if (price > 0) this.state.lastPrice = price;
    if (bid > 0) this.state.bid = bid;
    if (ask > 0) this.state.ask = ask;
    this.state.updatedAt = Date.now();
    this.updateMicroprice();
    this.callbacks.onState?.(this.getState());
  }

  private updateMicroprice(): void {
    const { bid, ask, lastPrice } = this.state;
    if (bid > 0 && ask > 0) {
      this.state.microprice = (bid + ask) / 2;
      return;
    }
    this.state.microprice = lastPrice;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    logger.warn({ delay, attempt: this.reconnectAttempts }, "Reconnecting to Coinbase");
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.callbacks.onReconnect?.();
    }, delay);
  }
}
