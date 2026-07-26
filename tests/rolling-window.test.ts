import { describe, expect, it } from "vitest";
import { PriceHistory } from "../src/market/rolling-window.js";

describe("PriceHistory.getRealizedVolatilityPerSqrtSecond", () => {
  it("scales with elapsed time, not tick count", () => {
    const start = 1_000_000;
    const tickReturn = 0.001;

    // Same 11 ticks (10 returns of 0.1% each), spread over 10 seconds
    const fast = new PriceHistory();
    let price = 100;
    for (let i = 0; i <= 10; i += 1) {
      fast.addPrice(start + i * 1_000, price);
      price *= Math.exp(tickReturn);
    }
    const fastVol = fast.getRealizedVolatilityPerSqrtSecond(
      60_000,
      start + 10_000,
    );

    // ...versus spread over 100 seconds
    const slow = new PriceHistory();
    price = 100;
    for (let i = 0; i <= 10; i += 1) {
      slow.addPrice(start + i * 10_000, price);
      price *= Math.exp(tickReturn);
    }
    const slowVol = slow.getRealizedVolatilityPerSqrtSecond(
      900_000,
      start + 100_000,
    );

    // variance per second = sum(r^2) / elapsed = 10 * r^2 / T
    expect(fastVol).toBeCloseTo(Math.sqrt((10 * tickReturn ** 2) / 10), 8);
    expect(slowVol).toBeCloseTo(Math.sqrt((10 * tickReturn ** 2) / 100), 8);
    expect(fastVol!).toBeCloseTo(slowVol! * Math.sqrt(10), 8);
  });

  it("returns null without enough data", () => {
    const history = new PriceHistory();
    expect(history.getRealizedVolatilityPerSqrtSecond(60_000)).toBeNull();
    history.addPrice(Date.now(), 100);
    expect(history.getRealizedVolatilityPerSqrtSecond(60_000)).toBeNull();
  });
});
