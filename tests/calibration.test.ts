import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  fitPlattCalibration,
  fitVolScale,
  logit,
  meanBrierScore,
  sigmoid,
  type CalibrationSample,
  type VolScaleSample,
} from "../src/model/calibration.js";

// Deterministic pseudo-random generator so fitting tests are stable.
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("calibration primitives", () => {
  it("logit and sigmoid are inverses", () => {
    for (const p of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 8);
    }
  });

  it("identity calibration leaves probabilities unchanged", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      expect(applyCalibration(p, { intercept: 0, slope: 1 })).toBeCloseTo(p, 8);
    }
  });

  it("computes mean Brier score", () => {
    expect(
      meanBrierScore([
        { probability: 1, outcome: 1 },
        { probability: 0.5, outcome: 0 },
      ]),
    ).toBeCloseTo(0.125);
  });
});

describe("fitPlattCalibration", () => {
  it("returns null below the minimum sample count", () => {
    const samples: CalibrationSample[] = Array.from({ length: 50 }, () => ({
      rawProbability: 0.6,
      outcome: 1,
    }));
    expect(fitPlattCalibration(samples, { minSamples: 100 })).toBeNull();
  });

  it("recovers a known overconfidence factor from synthetic data", () => {
    const rng = makeRng(42);
    const trueIntercept = 0.3;
    const trueSlope = 0.6;

    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 4000; i += 1) {
      // Raw model log-odds uniform in [-3, 3]
      const x = (rng() - 0.5) * 6;
      const rawProbability = sigmoid(x);
      const trueProbability = sigmoid(trueIntercept + trueSlope * x);
      samples.push({
        rawProbability,
        outcome: rng() < trueProbability ? 1 : 0,
      });
    }

    const fitted = fitPlattCalibration(samples);
    expect(fitted).not.toBeNull();
    expect(fitted!.intercept).toBeCloseTo(trueIntercept, 0);
    expect(fitted!.slope).toBeCloseTo(trueSlope, 0);
    expect(Math.abs(fitted!.intercept - trueIntercept)).toBeLessThan(0.15);
    expect(Math.abs(fitted!.slope - trueSlope)).toBeLessThan(0.15);
  });

  it("improves Brier score on overconfident predictions", () => {
    const rng = makeRng(7);
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const x = (rng() - 0.5) * 8;
      // Model is 2x overconfident: true log-odds are half the claimed ones
      const rawProbability = sigmoid(x);
      const trueProbability = sigmoid(0.5 * x);
      samples.push({
        rawProbability,
        outcome: rng() < trueProbability ? 1 : 0,
      });
    }

    const fitted = fitPlattCalibration(samples)!;
    const rawBrier = meanBrierScore(
      samples.map((s) => ({ probability: s.rawProbability, outcome: s.outcome })),
    );
    const calibratedBrier = meanBrierScore(
      samples.map((s) => ({
        probability: applyCalibration(s.rawProbability, fitted),
        outcome: s.outcome,
      })),
    );

    expect(fitted.slope).toBeLessThan(0.75);
    expect(calibratedBrier).toBeLessThan(rawBrier);
  });
});

describe("fitVolScale", () => {
  it("returns null below the minimum sample count", () => {
    const samples: VolScaleSample[] = Array.from({ length: 10 }, () => ({
      predictedStdDev: 100,
      realizedMove: 150,
    }));
    expect(fitVolScale(samples, { minSamples: 30 })).toBeNull();
  });

  it("detects underestimated volatility", () => {
    // Realized moves consistently 1.5x the predicted std dev
    const samples: VolScaleSample[] = Array.from({ length: 100 }, (_, i) => ({
      predictedStdDev: 100,
      realizedMove: i % 2 === 0 ? 150 : -150,
    }));
    expect(fitVolScale(samples, { decay: 1 })).toBeCloseTo(1.5, 5);
  });

  it("clamps extreme scales", () => {
    const samples: VolScaleSample[] = Array.from({ length: 100 }, () => ({
      predictedStdDev: 10,
      realizedMove: 500,
    }));
    expect(fitVolScale(samples)).toBe(2);

    const tiny: VolScaleSample[] = Array.from({ length: 100 }, () => ({
      predictedStdDev: 1000,
      realizedMove: 1,
    }));
    expect(fitVolScale(tiny)).toBe(0.5);
  });
});
