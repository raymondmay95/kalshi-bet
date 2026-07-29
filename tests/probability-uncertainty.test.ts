import { describe, expect, it } from "vitest";
import { calculateBaselineProbability } from "../src/model/baseline-probability.js";
import {
  conservativeEdge,
  estimateProbabilityUncertainty,
  probabilityEdgeIsPositive,
} from "../src/model/probability-uncertainty.js";

const baseInput = {
  currentPrice: 118_000,
  threshold: 117_900,
  secondsRemaining: 300,
  volatilityPerSqrtSecond: 11.8,
  driftPerSecond: 0.02,
  pointEstimate: 0.68,
};

describe("probability uncertainty", () => {
  it("never reports impossible precision", () => {
    const u = estimateProbabilityUncertainty(baseInput);
    expect(u.standardError).toBeGreaterThanOrEqual(0.005);
    expect(u.standardError).toBeLessThanOrEqual(0.25);
  });

  it("keeps the model-error floor even when every input is certain", () => {
    const u = estimateProbabilityUncertainty({
      ...baseInput,
      driftPerSecond: 0,
      modelErrorFloor: 0.02,
    });
    expect(u.standardError).toBeGreaterThanOrEqual(0.02);
  });

  it("grows when the volatility estimate is less trustworthy", () => {
    const trusted = estimateProbabilityUncertainty({
      ...baseInput,
      volRelativeError: 0.1,
    });
    const doubtful = estimateProbabilityUncertainty({
      ...baseInput,
      volRelativeError: 0.5,
    });
    expect(doubtful.standardError).toBeGreaterThan(trusted.standardError);
    expect(doubtful.volatilityComponent).toBeGreaterThan(
      trusted.volatilityComponent,
    );
  });

  it("charges uncertainty for relying on drift", () => {
    const noDrift = estimateProbabilityUncertainty({
      ...baseInput,
      driftPerSecond: 0,
    });
    const heavyDrift = estimateProbabilityUncertainty({
      ...baseInput,
      driftPerSecond: 0.5,
    });
    expect(noDrift.driftComponent).toBeCloseTo(0, 6);
    expect(heavyDrift.driftComponent).toBeGreaterThan(0);
  });

  it("adds Monte Carlo sampling error only when paths were simulated", () => {
    const analytical = estimateProbabilityUncertainty(baseInput);
    const simulated = estimateProbabilityUncertainty({
      ...baseInput,
      monteCarloPathCount: 500,
    });
    expect(analytical.samplingComponent).toBe(0);
    expect(simulated.samplingComponent).toBeGreaterThan(0);
    // sqrt(p(1-p)/n) for p=0.68, n=500
    expect(simulated.samplingComponent).toBeCloseTo(0.0209, 3);
  });

  it("shrinks sampling error as paths increase", () => {
    const few = estimateProbabilityUncertainty({
      ...baseInput,
      monteCarloPathCount: 500,
    });
    const many = estimateProbabilityUncertainty({
      ...baseInput,
      monteCarloPathCount: 10_000,
    });
    expect(many.samplingComponent).toBeLessThan(few.samplingComponent);
  });

  it("is near-certain about an outcome that is already decided", () => {
    const decided = estimateProbabilityUncertainty({
      ...baseInput,
      threshold: 110_000,
      secondsRemaining: 40,
      pointEstimate: 0.99,
    });
    expect(decided.standardError).toBeLessThan(0.05);
  });
});

describe("edge certainty", () => {
  it("is a coin flip at zero edge and rises with edge", () => {
    expect(probabilityEdgeIsPositive(0, 0.04)).toBeCloseTo(0.5, 2);
    expect(probabilityEdgeIsPositive(0.04, 0.04)).toBeCloseTo(0.84, 2);
    expect(probabilityEdgeIsPositive(-0.04, 0.04)).toBeCloseTo(0.16, 2);
  });

  it("rates the same edge lower when the estimate is noisier", () => {
    expect(probabilityEdgeIsPositive(0.03, 0.02)).toBeGreaterThan(
      probabilityEdgeIsPositive(0.03, 0.1),
    );
  });

  it("collapses to a hard yes or no with no uncertainty", () => {
    expect(probabilityEdgeIsPositive(0.01, 0)).toBe(1);
    expect(probabilityEdgeIsPositive(-0.01, 0)).toBe(0);
  });
});

describe("conservative edge", () => {
  it("discounts the edge by a fraction of its own error", () => {
    expect(conservativeEdge(0.05, 0.04, 0.5)).toBeCloseTo(0.03, 6);
  });

  it("can turn a noisy positive edge negative", () => {
    expect(conservativeEdge(0.02, 0.2, 0.5)).toBeLessThan(0);
  });
});

describe("measured settlement basis", () => {
  const input = {
    currentPrice: 100_000,
    threshold: 100_000,
    secondsRemaining: 300,
    volatilityPerSqrtSecond: 8,
    driftPerSecond: 0,
    pointEstimate: 0.5,
    modelErrorFloor: 0.02,
    measuredBasisErrorFloor: 0.01,
  };

  it("drops the error floor once the basis is measured rather than assumed", () => {
    const assumed = estimateProbabilityUncertainty(input);
    const measured = estimateProbabilityUncertainty(input, {
      settlementBasis: { offset: 0, stdDev: 20 },
    });

    expect(assumed.usedMeasuredBasis).toBe(false);
    expect(assumed.modelComponent).toBeCloseTo(0.02, 6);
    expect(measured.usedMeasuredBasis).toBe(true);
    expect(measured.modelComponent).toBeCloseTo(0.01, 6);
    expect(measured.standardError).toBeLessThan(assumed.standardError);
  });

  it("keeps the volatility learner's signal free of the basis", () => {
    const withoutBasis = calculateBaselineProbability(input);
    const withBasis = calculateBaselineProbability(input, {
      settlementBasis: { offset: 0, stdDev: 40 },
    });

    // remainingStdDev trains fitVolScale against moves measured on our own
    // feed, so it must stay diffusion-only; only settlementStdDev absorbs it.
    expect(withBasis.remainingStdDev).toBeCloseTo(withoutBasis.remainingStdDev, 6);
    expect(withBasis.settlementStdDev).toBeGreaterThan(
      withoutBasis.settlementStdDev,
    );
    expect(withoutBasis.settlementStdDev).toBeCloseTo(
      withoutBasis.remainingStdDev,
      6,
    );
  });

  it("combines basis and diffusion in quadrature", () => {
    const result = calculateBaselineProbability(input, {
      settlementBasis: { offset: 0, stdDev: 60 },
    });
    expect(result.settlementStdDev).toBeCloseTo(
      Math.hypot(result.remainingStdDev, 60),
      6,
    );
  });

  it("shifts the call when our feed trades cheap to the index", () => {
    const neutral = calculateBaselineProbability(input);
    const indexAbove = calculateBaselineProbability(input, {
      settlementBasis: { offset: 80, stdDev: 10 },
    });

    expect(neutral.rawHighProbability).toBeCloseTo(0.5, 2);
    expect(indexAbove.rawHighProbability).toBeGreaterThan(
      neutral.rawHighProbability,
    );
  });
});
