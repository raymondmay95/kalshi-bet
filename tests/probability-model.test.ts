import { describe, expect, it } from "vitest";
import {
  calculateBaselineProbability,
  effectiveSecondsForSettlement,
  normalCdf,
} from "../src/model/baseline-probability.js";

describe("baseline probability model", () => {
  it("computes normal cdf", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 2);
    expect(normalCdf(2)).toBeGreaterThan(0.9);
    expect(normalCdf(-2)).toBeLessThan(0.1);
  });

  it("uses effective seconds for 60s settlement average", () => {
    expect(effectiveSecondsForSettlement(120)).toBe(90);
    expect(effectiveSecondsForSettlement(20)).toBe(1);
  });

  it("returns probabilities between 0 and 1 that sum to 1", () => {
    const result = calculateBaselineProbability({
      currentPrice: 65000,
      threshold: 64500,
      secondsRemaining: 300,
      volatilityPerSqrtSecond: 5,
    });

    expect(result.rawHighProbability).toBeGreaterThanOrEqual(0);
    expect(result.rawHighProbability).toBeLessThanOrEqual(1);
    expect(result.adjustedHighProbability + result.lowProbability).toBeCloseTo(1);
  });

  it("favors HIGH when far above threshold near expiry", () => {
    const result = calculateBaselineProbability({
      currentPrice: 65100,
      threshold: 64500,
      secondsRemaining: 60,
      volatilityPerSqrtSecond: 2,
    });

    expect(result.adjustedHighProbability).toBeGreaterThan(0.7);
  });

  it("does not crash with zero volatility", () => {
    const result = calculateBaselineProbability({
      currentPrice: 64500,
      threshold: 64500,
      secondsRemaining: 300,
      volatilityPerSqrtSecond: 0,
    });

    expect(result.adjustedHighProbability).toBeGreaterThanOrEqual(0);
    expect(result.adjustedHighProbability).toBeLessThanOrEqual(1);
  });
});
