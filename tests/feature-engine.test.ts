import { describe, expect, it } from "vitest";
import {
  computeBookImbalance,
  computeMicroprice,
  computeTradeImbalance,
  FeatureEngine,
} from "../src/market/feature-engine.js";
import type { BinanceMarketState } from "../src/binance/binance-types.js";
import type { KalshiMarketState } from "../src/kalshi/kalshi-types.js";

describe("FeatureEngine", () => {
  it("computes trade and book imbalance helpers", () => {
    expect(computeTradeImbalance(70, 30)).toBeCloseTo(0.4);
    expect(computeBookImbalance(100, 50)).toBeCloseTo(1 / 3);
    expect(computeMicroprice(100, 101, 10, 5)).toBeCloseTo(100.667, 2);
  });

  it("computes feature snapshot from market state", () => {
    const engine = new FeatureEngine();
    engine.onPrice(Date.now() - 60_000, 64000);
    engine.onPrice(Date.now(), 64500);

    const binance: BinanceMarketState = {
      symbol: "BTCUSDT",
      lastPrice: 64500,
      bid: 64499,
      ask: 64501,
      bidQty: 1,
      askQty: 1,
      lastTradeTime: Date.now(),
      updatedAt: Date.now(),
      bidDepth: 10,
      askDepth: 8,
      microprice: 64500,
      buyVolume: 5,
      sellVolume: 3,
      tradeCount: 2,
    };

    const kalshi: KalshiMarketState = {
      market: {
        ticker: "TEST",
        eventTicker: "EVT",
        title: "Test",
        status: "open",
        openTime: new Date(),
        closeTime: new Date(Date.now() + 600_000),
        floorStrike: 64400,
        yesBid: 0.55,
        yesAsk: 0.58,
        noBid: 0.4,
        noAsk: 0.43,
        settlementSource: "BRTI",
        settlementRule: "60s average",
      },
      yesBid: 0.55,
      yesAsk: 0.58,
      noBid: 0.4,
      noAsk: 0.43,
      yesSpread: 0.03,
      noSpread: 0.03,
      yesLiquidity: 100,
      noLiquidity: 100,
      updatedAt: Date.now(),
    };

    const features = engine.computeFeatures({
      binance,
      kalshi,
      threshold: 64400,
      secondsRemaining: 300,
    });

    expect(features.distanceToThreshold).toBe(100);
    expect(features.tradeImbalance).toBeCloseTo(0.25);
    expect(features.bookImbalance).toBeCloseTo(0.111, 2);
  });
});
