import WebSocket from "ws";
import { getEnv } from "../config/environment.js";
import { logger } from "../config/logger.js";
import type {
  BinanceAggTrade,
  BinanceBookTicker,
  BinanceDepthUpdate,
  BinanceKline,
  BinanceMarketState,
  CandleRecord,
  TradeRecord,
} from "./binance-types.js";

export interface BinanceFeedCallbacks {
  onTrade?: (trade: TradeRecord) => void;
  onState?: (state: BinanceMarketState) => void;
  onCandle?: (candle: CandleRecord) => void;
  onReconnect?: () => void;
}

export class BinanceFeedService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private state: BinanceMarketState = {
    symbol: "BTCUSDT",
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

  constructor(private readonly callbacks: BinanceFeedCallbacks = {}) {}

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
    const env = getEnv();
    const streams = [
      "btcusdt@aggTrade",
      "btcusdt@bookTicker",
      "btcusdt@depth20@100ms",
      "btcusdt@kline_1m",
    ];
    const base = env.BINANCE_WS_BASE.replace(/\/ws\/?$/, "");
    const url = `${base}/stream?streams=${streams.join("/")}`;

    logger.info({ url }, "Connecting to Binance WebSocket");
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      logger.info("Binance WebSocket connected");
    });

    this.ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as
          | BinanceAggTrade
          | BinanceBookTicker
          | { stream?: string; data?: unknown };

        if ("stream" in payload && payload.data) {
          this.handlePayload(payload.data);
        } else {
          this.handlePayload(payload);
        }
      } catch (error) {
        logger.warn({ error }, "Failed to parse Binance message");
      }
    });

    this.ws.on("close", () => {
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (error) => {
      logger.error({ error }, "Binance WebSocket error");
    });
  }

  private handlePayload(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;

    const event = payload as Record<string, unknown>;

    if (event.e === "aggTrade") {
      this.handleAggTrade(event as unknown as BinanceAggTrade);
      return;
    }

    if ("b" in event && "a" in event && "s" in event && !("e" in event)) {
      this.handleBookTicker(event as unknown as BinanceBookTicker);
      return;
    }

    if ("lastUpdateId" in event && "bids" in event) {
      this.handleDepth(event as unknown as BinanceDepthUpdate);
      return;
    }

    if (event.e === "kline" && event.k) {
      this.handleKline(event.k as BinanceKline);
    }
  }

  private handleAggTrade(trade: BinanceAggTrade): void {
    const price = Number(trade.p);
    const quantity = Number(trade.q);
    const timestamp = trade.T;

    this.state.lastPrice = price;
    this.state.lastTradeTime = timestamp;
    this.state.updatedAt = Date.now();
    this.state.tradeCount += 1;

    if (trade.m) {
      this.state.sellVolume += quantity;
    } else {
      this.state.buyVolume += quantity;
    }

    this.updateMicroprice();
    this.callbacks.onTrade?.({
      price,
      quantity,
      timestamp,
      isBuyerMaker: trade.m,
    });
    this.callbacks.onState?.(this.getState());
  }

  private handleBookTicker(ticker: BinanceBookTicker): void {
    this.state.bid = Number(ticker.b);
    this.state.ask = Number(ticker.a);
    this.state.bidQty = Number(ticker.B);
    this.state.askQty = Number(ticker.A);
    this.state.updatedAt = Date.now();
    this.updateMicroprice();
    this.callbacks.onState?.(this.getState());
  }

  private handleDepth(depth: BinanceDepthUpdate): void {
    this.state.bidDepth = depth.bids.reduce(
      (sum, [, qty]) => sum + Number(qty),
      0,
    );
    this.state.askDepth = depth.asks.reduce(
      (sum, [, qty]) => sum + Number(qty),
      0,
    );
    this.state.updatedAt = Date.now();
    this.callbacks.onState?.(this.getState());
  }

  private handleKline(kline: BinanceKline): void {
    const candle: CandleRecord = {
      timestamp: kline.t,
      open: Number(kline.o),
      high: Number(kline.h),
      low: Number(kline.l),
      close: Number(kline.c),
      volume: Number(kline.v),
    };
    this.callbacks.onCandle?.(candle);
  }

  private updateMicroprice(): void {
    const { bid, ask, bidQty, askQty } = this.state;
    const totalQty = bidQty + askQty;
    if (totalQty <= 0) {
      this.state.microprice = this.state.lastPrice || (bid + ask) / 2;
      return;
    }
    this.state.microprice =
      (ask * bidQty + bid * askQty) / totalQty;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    logger.warn({ delay, attempt: this.reconnectAttempts }, "Reconnecting to Binance");
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.callbacks.onReconnect?.();
    }, delay);
  }
}
