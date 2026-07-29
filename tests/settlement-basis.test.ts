import { describe, expect, it } from "vitest";
import {
  basisHighProbability,
  countInformativeSamples,
  fitSettlementBasis,
  maximizeBasisLikelihood,
  meanLogLoss,
  type SettlementBasisSample,
} from "../src/model/settlement-basis.js";

/** Deterministic uniform stream so recovery tests are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function standardNormal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Synthesize settled intervals from a known basis. Distances are drawn wide
 * enough to include plenty of near-strike intervals, which is what carries the
 * information the fit needs.
 */
function syntheticSamples(input: {
  count: number;
  offset: number;
  stdDev: number;
  distanceSpread: number;
  seed: number;
}): SettlementBasisSample[] {
  const random = makeRandom(input.seed);
  const samples: SettlementBasisSample[] = [];
  for (let i = 0; i < input.count; i += 1) {
    const distance = (random() * 2 - 1) * input.distanceSpread;
    const epsilon = input.offset + input.stdDev * standardNormal(random);
    samples.push({
      distance,
      outcome: distance + epsilon > 0 ? 1 : 0,
    });
  }
  return samples;
}

describe("settlement basis", () => {
  it("recovers a known basis standard deviation from settled outcomes", () => {
    const samples = syntheticSamples({
      count: 4000,
      offset: 0,
      stdDev: 20,
      distanceSpread: 120,
      seed: 12345,
    });

    const basis = maximizeBasisLikelihood(samples);
    expect(basis).not.toBeNull();
    expect(basis!.stdDev).toBeGreaterThan(14);
    expect(basis!.stdDev).toBeLessThan(28);
    expect(Math.abs(basis!.offset)).toBeLessThan(8);
  });

  it("recovers a systematic offset", () => {
    const samples = syntheticSamples({
      count: 4000,
      offset: 30,
      stdDev: 15,
      distanceSpread: 150,
      seed: 999,
    });

    const basis = maximizeBasisLikelihood(samples);
    expect(basis).not.toBeNull();
    expect(basis!.offset).toBeGreaterThan(20);
    expect(basis!.offset).toBeLessThan(42);
  });

  it("returns null below the sample gate", () => {
    const samples = syntheticSamples({
      count: 50,
      offset: 0,
      stdDev: 20,
      distanceSpread: 100,
      seed: 7,
    });
    expect(fitSettlementBasis(samples, { minSamples: 150 })).toBeNull();
  });

  it("refuses to fit when no interval landed near the strike", () => {
    // Every settlement is thousands of dollars from the strike, so the outcomes
    // are unanimous and carry no information about the basis.
    const samples: SettlementBasisSample[] = [];
    for (let i = 0; i < 400; i += 1) {
      const distance = i % 2 === 0 ? 5000 : -5000;
      samples.push({ distance, outcome: distance > 0 ? 1 : 0 });
    }
    const fit = fitSettlementBasis(samples, {
      minSamples: 150,
      minInformativeSamples: 40,
    });
    expect(fit).toBeNull();
  });

  it("promotes a fit that beats the fallback out of sample", () => {
    const samples = syntheticSamples({
      count: 1200,
      offset: 0,
      stdDev: 6,
      distanceSpread: 60,
      seed: 4242,
    });

    const fit = fitSettlementBasis(samples, {
      minSamples: 150,
      minInformativeSamples: 20,
      fallbackStdDev: 25,
    });

    expect(fit).not.toBeNull();
    expect(fit!.stdDev).toBeLessThan(12);
    expect(fit!.validationLogLoss).toBeLessThanOrEqual(fit!.baselineLogLoss);
    expect(fit!.informativeCount).toBeGreaterThan(0);
    expect(fit!.sampleCount).toBe(1200);
  });

  it("prices the strike at a coin flip once the offset is removed", () => {
    expect(basisHighProbability(0, { offset: 0, stdDev: 10 })).toBeCloseTo(0.5, 6);
  });

  it("treats a positive offset as settling above our feed", () => {
    const p = basisHighProbability(0, { offset: 20, stdDev: 10 });
    expect(p).toBeGreaterThan(0.9);
  });

  it("counts only near-strike samples as informative", () => {
    const samples: SettlementBasisSample[] = [
      { distance: 0, outcome: 1 },
      { distance: 5, outcome: 1 },
      { distance: 10_000, outcome: 1 },
      { distance: -10_000, outcome: 0 },
    ];
    expect(
      countInformativeSamples(samples, { offset: 0, stdDev: 10 }),
    ).toBe(2);
  });

  it("scores a confident wrong call worse than an uncertain one", () => {
    const confidentWrong = meanLogLoss([{ probability: 0.99, outcome: 0 }]);
    const uncertain = meanLogLoss([{ probability: 0.5, outcome: 0 }]);
    expect(confidentWrong).toBeGreaterThan(uncertain);
  });
});
