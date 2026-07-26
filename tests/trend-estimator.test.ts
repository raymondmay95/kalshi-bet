import { describe, expect, it } from "vitest";
import { estimateTrend } from "../src/model/trend-estimator.js";

describe("trend estimator", () => {
  it("returns zero drift with no signals", () => {
    const trend = estimateTrend({
      price: 100_000,
      returnsBps: {},
      tradeImbalance: 0,
      bookImbalance: 0,
    });
    expect(trend.driftDollarsPerSecond).toBe(0);
    expect(trend.driftBpsPerSecond).toBe(0);
  });

  it("produces positive drift from upward momentum", () => {
    const trend = estimateTrend({
      price: 100_000,
      returnsBps: {
        return_60000ms_bps: 12, // +12 bps over the last minute
        return_180000ms_bps: 24,
        return_300000ms_bps: 30,
      },
      tradeImbalance: 0,
      bookImbalance: 0,
    });

    expect(trend.momentumBpsPerSecond).toBeGreaterThan(0);
    expect(trend.driftDollarsPerSecond).toBeGreaterThan(0);
    // Persistence damping means we project less than the observed rate
    expect(trend.momentumBpsPerSecond).toBeLessThan(12 / 60);
  });

  it("produces negative drift from sell-side flow", () => {
    const trend = estimateTrend({
      price: 100_000,
      returnsBps: {},
      tradeImbalance: -0.8,
      bookImbalance: -0.5,
    });

    expect(trend.flowBpsPerSecond).toBeLessThan(0);
    expect(trend.driftDollarsPerSecond).toBeLessThan(0);
  });

  it("keeps drift small relative to typical 15-minute volatility", () => {
    // Even at maximum imbalance and strong momentum, drift over 900s
    // should stay in the tens of bps, not hundreds.
    const trend = estimateTrend({
      price: 100_000,
      returnsBps: {
        return_60000ms_bps: 20,
        return_180000ms_bps: 40,
        return_300000ms_bps: 60,
      },
      tradeImbalance: 1,
      bookImbalance: 1,
    });

    const driftBpsOver15Min = trend.driftBpsPerSecond * 900;
    expect(Math.abs(driftBpsOver15Min)).toBeLessThan(150);
  });
});
