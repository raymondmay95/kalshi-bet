import type { BinanceMarketState, TradeRecord } from "../binance/binance-types.js";
import type { KalshiMarketState } from "../kalshi/kalshi-types.js";
import {
  PriceHistory,
  RETURN_WINDOWS_MS,
  VOL_WINDOWS_MS,
} from "./rolling-window.js";

export interface FeatureSnapshot {
  timestamp: number;
  currentPrice: number;
  threshold: number;
  distanceToThreshold: number;
  distanceToThresholdBps: number;
  secondsRemaining: number;
  returns: Record<string, number | null>;
  realizedVolatility: Record<string, number | null>;
  /** Relative log-return volatility per sqrt-second, keyed by window. */
  volatilityPerSqrtSecond: Record<string, number | null>;
  tradeImbalance: number;
  bookImbalance: number;
  microprice: number;
  vwapDistanceBps: number | null;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  kalshiNoBid: number;
  kalshiNoAsk: number;
  kalshiYesSpread: number;
  kalshiImpliedProbability: number;
}

export class FeatureEngine {
  private priceHistory = new PriceHistory();
  private vwapNumerator = 0;
  private vwapDenominator = 0;
  private vwapWindowStart = Date.now();
  private readonly vwapWindowMs = 60_000;

  onPrice(timestamp: number, price: number): void {
    this.priceHistory.addPrice(timestamp, price);
  }

  onTrade(trade: TradeRecord): void {
    this.onPrice(trade.timestamp, trade.price);
    this.updateVwap(trade);
  }

  onBinanceState(state: BinanceMarketState): void {
    if (state.lastPrice > 0) {
      this.onPrice(state.updatedAt, state.lastPrice);
    }
  }

  computeFeatures(input: {
    binance: BinanceMarketState;
    kalshi: KalshiMarketState;
    threshold: number;
    secondsRemaining: number;
    now?: number;
  }): FeatureSnapshot {
    const now = input.now ?? Date.now();
    const price = input.binance.lastPrice || input.binance.microprice;
    const distanceToThreshold = price - input.threshold;
    const distanceToThresholdBps =
      input.threshold > 0
        ? (distanceToThreshold / input.threshold) * 10_000
        : 0;

    const returns: Record<string, number | null> = {};
    for (const windowMs of RETURN_WINDOWS_MS) {
      returns[`return_${windowMs}ms_bps`] =
        this.priceHistory.getReturnBps(windowMs, now);
    }

    const realizedVolatility: Record<string, number | null> = {};
    const volatilityPerSqrtSecond: Record<string, number | null> = {};
    for (const windowMs of VOL_WINDOWS_MS) {
      realizedVolatility[`vol_${windowMs}ms`] =
        this.priceHistory.getRealizedVolatility(windowMs, now);
      volatilityPerSqrtSecond[`volps_${windowMs}ms`] =
        this.priceHistory.getRealizedVolatilityPerSqrtSecond(windowMs, now);
    }

    const totalVolume =
      input.binance.buyVolume + input.binance.sellVolume;
    const tradeImbalance =
      totalVolume > 0
        ? (input.binance.buyVolume - input.binance.sellVolume) / totalVolume
        : 0;

    const totalDepth =
      input.binance.bidDepth + input.binance.askDepth;
    const bookImbalance =
      totalDepth > 0
        ? (input.binance.bidDepth - input.binance.askDepth) / totalDepth
        : 0;

    const vwap = this.getVwap(now);
    const vwapDistanceBps =
      vwap && vwap > 0 ? Math.log(price / vwap) * 10_000 : null;

    const kalshiImpliedProbability =
      input.kalshi.yesAsk > 0
        ? input.kalshi.yesAsk
        : input.kalshi.yesBid;

    return {
      timestamp: now,
      currentPrice: price,
      threshold: input.threshold,
      distanceToThreshold,
      distanceToThresholdBps,
      secondsRemaining: input.secondsRemaining,
      returns,
      realizedVolatility,
      volatilityPerSqrtSecond,
      tradeImbalance,
      bookImbalance,
      microprice: input.binance.microprice || price,
      vwapDistanceBps,
      kalshiYesBid: input.kalshi.yesBid,
      kalshiYesAsk: input.kalshi.yesAsk,
      kalshiNoBid: input.kalshi.noBid,
      kalshiNoAsk: input.kalshi.noAsk,
      kalshiYesSpread: input.kalshi.yesSpread,
      kalshiImpliedProbability,
    };
  }

  private updateVwap(trade: TradeRecord): void {
    const now = trade.timestamp;
    if (now - this.vwapWindowStart > this.vwapWindowMs) {
      this.vwapNumerator = 0;
      this.vwapDenominator = 0;
      this.vwapWindowStart = now;
    }
    this.vwapNumerator += trade.price * trade.quantity;
    this.vwapDenominator += trade.quantity;
  }

  private getVwap(now: number): number | null {
    if (now - this.vwapWindowStart > this.vwapWindowMs) {
      this.vwapNumerator = 0;
      this.vwapDenominator = 0;
      this.vwapWindowStart = now;
    }
    if (this.vwapDenominator <= 0) return null;
    return this.vwapNumerator / this.vwapDenominator;
  }
}

export function computeMicroprice(
  bid: number,
  ask: number,
  bidQty: number,
  askQty: number,
): number {
  const totalQty = bidQty + askQty;
  if (totalQty <= 0) return (bid + ask) / 2;
  return (ask * bidQty + bid * askQty) / totalQty;
}

export function computeTradeImbalance(
  buyVolume: number,
  sellVolume: number,
): number {
  const total = buyVolume + sellVolume;
  if (total <= 0) return 0;
  return (buyVolume - sellVolume) / total;
}

export function computeBookImbalance(
  bidDepth: number,
  askDepth: number,
): number {
  const total = bidDepth + askDepth;
  if (total <= 0) return 0;
  return (bidDepth - askDepth) / total;
}
