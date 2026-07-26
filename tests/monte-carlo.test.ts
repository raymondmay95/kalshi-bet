import { describe, expect, it } from "vitest";
import {
  createRng,
  runSettlementMonteCarlo,
} from "../src/prediction/monte-carlo.js";

describe("settlement Monte Carlo", () => {
  it("returns reproducible results for the same seed", () => {
    const input = {
      currentPrice: 100_000,
      strike: 100_000,
      secondsRemaining: 120,
      volatility: 8,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 2000,
      seed: 42,
      shockDistribution: "normal" as const,
    };
    const a = runSettlementMonteCarlo(input);
    const b = runSettlementMonteCarlo(input);
    expect(a.highProbability).toBe(b.highProbability);
    expect(a.estimatedSettlementAverage).toBe(b.estimatedSettlementAverage);
  });

  it("HIGH and LOW probabilities sum to approximately 1", () => {
    const result = runSettlementMonteCarlo({
      currentPrice: 100_000,
      strike: 99_500,
      secondsRemaining: 300,
      volatility: 10,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 3000,
      seed: 7,
      shockDistribution: "normal",
    });
    expect(result.highProbability + result.lowProbability).toBeCloseTo(1, 9);
  });

  it("favors HIGH when far above strike near expiry", () => {
    const result = runSettlementMonteCarlo({
      currentPrice: 101_000,
      strike: 100_000,
      secondsRemaining: 30,
      volatility: 2,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 4000,
      seed: 11,
      shockDistribution: "normal",
      observedSettlementPrices: Array(30).fill(101_000),
    });
    expect(result.highProbability).toBeGreaterThan(0.85);
  });

  it("partially observed settlement window reduces uncertainty", () => {
    const open = runSettlementMonteCarlo({
      currentPrice: 100_050,
      strike: 100_000,
      secondsRemaining: 300,
      volatility: 15,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 5000,
      seed: 99,
      shockDistribution: "normal",
    });

    const partial = runSettlementMonteCarlo({
      currentPrice: 100_050,
      strike: 100_000,
      secondsRemaining: 20,
      volatility: 15,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 5000,
      seed: 99,
      shockDistribution: "normal",
      observedSettlementPrices: Array(40).fill(100_050),
    });

    // With most of the window already above strike, probability should be higher
    // and closer to certainty than the open-window case.
    expect(partial.highProbability).toBeGreaterThan(open.highProbability);
    expect(partial.highProbability).toBeGreaterThan(0.7);
  });

  it("estimated settlement average tracks observed prices in-window", () => {
    const result = runSettlementMonteCarlo({
      currentPrice: 100_000,
      strike: 100_000,
      secondsRemaining: 5,
      volatility: 0.0001,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 1000,
      seed: 3,
      shockDistribution: "normal",
      observedSettlementPrices: Array(55).fill(99_000),
    });
    expect(result.estimatedSettlementAverage).toBeLessThan(99_500);
    expect(result.highProbability).toBeLessThan(0.2);
  });

  it("student-t distribution is usable", () => {
    const result = runSettlementMonteCarlo({
      currentPrice: 100_000,
      strike: 100_000,
      secondsRemaining: 180,
      volatility: 8,
      drift: 0,
      settlementWindowSeconds: 60,
      pathCount: 2000,
      seed: 5,
      shockDistribution: "student-t",
      studentTDegreesOfFreedom: 5,
    });
    expect(result.highProbability).toBeGreaterThan(0.2);
    expect(result.highProbability).toBeLessThan(0.8);
  });

  it("rng is deterministic", () => {
    const a = createRng(123);
    const b = createRng(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
