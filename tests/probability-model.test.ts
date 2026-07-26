import { describe, expect, it } from "vitest";
import {
  blendVolatilityPerSqrtSecond,
  calculateBaselineProbability,
  effectiveSecondsForSettlement,
  estimateVolatilityPerSqrtSecond,
  normalCdf,
  shrinkTowardHalfInLogOdds,
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

  it("never claims certainty", () => {
    const result = calculateBaselineProbability({
      currentPrice: 70000,
      threshold: 64500,
      secondsRemaining: 60,
      volatilityPerSqrtSecond: 2,
    });

    expect(result.adjustedHighProbability).toBeLessThanOrEqual(0.99);
    expect(result.lowProbability).toBeGreaterThanOrEqual(0.01);
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

  it("positive drift raises the HIGH probability", () => {
    const base = {
      currentPrice: 64500,
      threshold: 64500,
      secondsRemaining: 900,
      volatilityPerSqrtSecond: 10,
    };
    const noDrift = calculateBaselineProbability(base);
    const upDrift = calculateBaselineProbability({
      ...base,
      driftPerSecond: 0.2,
    });
    const downDrift = calculateBaselineProbability({
      ...base,
      driftPerSecond: -0.2,
    });

    expect(upDrift.adjustedHighProbability).toBeGreaterThan(
      noDrift.adjustedHighProbability,
    );
    expect(downDrift.adjustedHighProbability).toBeLessThan(
      noDrift.adjustedHighProbability,
    );
  });

  it("caps the drift contribution relative to remaining volatility", () => {
    const result = calculateBaselineProbability({
      currentPrice: 64500,
      threshold: 64500,
      secondsRemaining: 900,
      volatilityPerSqrtSecond: 10,
      driftPerSecond: 1_000,
    });

    // 1.5 standard deviations at most
    expect(Math.abs(result.appliedDrift)).toBeLessThanOrEqual(
      1.5 * result.remainingStdDev + 1e-9,
    );
    expect(result.zScore).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it("shrinks probabilities toward 0.5 in log-odds space", () => {
    expect(shrinkTowardHalfInLogOdds(0.5, 0.85)).toBeCloseTo(0.5);
    expect(shrinkTowardHalfInLogOdds(0.9, 0.85)).toBeLessThan(0.9);
    expect(shrinkTowardHalfInLogOdds(0.9, 0.85)).toBeGreaterThan(0.5);
    expect(shrinkTowardHalfInLogOdds(0.1, 0.85)).toBeGreaterThan(0.1);
    expect(shrinkTowardHalfInLogOdds(0.1, 0.85)).toBeLessThan(0.5);
  });
});

describe("volatility estimation", () => {
  it("converts relative volatility to dollar volatility", () => {
    // 2 bps per sqrt-second at $100k => $20 per sqrt-second
    expect(estimateVolatilityPerSqrtSecond(2e-4, 100_000)).toBeCloseTo(20);
  });

  it("applies a price-relative floor instead of a fixed cent floor", () => {
    // Absurdly low estimate gets floored at 0.2 bps of price
    expect(estimateVolatilityPerSqrtSecond(1e-9, 100_000)).toBeCloseTo(2);
  });

  it("falls back to a sane relative volatility when missing", () => {
    // 1 bp per sqrt-second at $100k => $10 per sqrt-second
    expect(estimateVolatilityPerSqrtSecond(null, 100_000)).toBeCloseTo(10);
    expect(estimateVolatilityPerSqrtSecond(undefined, 100_000)).toBeCloseTo(10);
  });

  it("caps runaway estimates", () => {
    expect(estimateVolatilityPerSqrtSecond(1, 100_000)).toBeCloseTo(100);
  });

  it("blends multiple windows as a variance-weighted average", () => {
    const blended = blendVolatilityPerSqrtSecond([
      { value: 3, weight: 0.5 },
      { value: 4, weight: 0.5 },
    ]);
    // sqrt((9 + 16) / 2) = sqrt(12.5)
    expect(blended).toBeCloseTo(Math.sqrt(12.5));
  });

  it("ignores missing windows when blending", () => {
    const blended = blendVolatilityPerSqrtSecond([
      { value: null, weight: 0.5 },
      { value: 4, weight: 0.5 },
    ]);
    expect(blended).toBeCloseTo(4);
    expect(
      blendVolatilityPerSqrtSecond([{ value: null, weight: 1 }]),
    ).toBeNull();
  });
});
