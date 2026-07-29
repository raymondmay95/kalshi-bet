import { describe, expect, it } from "vitest";
import {
  makeDecision,
  marketImpliedHighProbability,
  type DecisionConfig,
} from "../src/decision/decision-engine.js";

/**
 * A fairly-priced market: the model and the market both say 70% HIGH, with a
 * realistic 2c spread on each side.
 */
const baseInput = {
  highProbability: 0.7,
  probabilityStdError: 0.04,
  yesBid: 0.69,
  yesAsk: 0.71,
  noBid: 0.29,
  noAsk: 0.31,
  yesLiquidity: 200,
  noLiquidity: 200,
  secondsRemaining: 300,
  dataIsStale: false,
  distanceToThresholdBps: 6.5,
  tradeImbalance: 0.2,
  momentum30s: 5,
  momentum3m: 10,
};

function testConfig(overrides: Partial<DecisionConfig> = {}): DecisionConfig {
  return {
    minimumEdge: 0.01,
    moderateEdge: 0.03,
    strongEdge: 0.06,
    minimumEdgeCertainty: 0.55,
    moderateEdgeCertainty: 0.65,
    strongEdgeCertainty: 0.75,
    maximumSpread: 0.15,
    minimumSecondsRemaining: 20,
    minimumLiquidity: 10,
    feeCoefficient: 0.07,
    slippage: 0.01,
    assumedOrderSize: 20,
    kellyMultiplier: 0.25,
    maximumStakeFraction: 0.02,
    minimumStakeFraction: 0.002,
    alwaysPickSide: true,
    ...overrides,
  };
}

describe("decision engine — a decision is always produced", () => {
  it("bets HIGH when the model is meaningfully above the market", () => {
    const decision = makeDecision(
      { ...baseInput, highProbability: 0.8 },
      testConfig(),
    );
    expect(decision.tradeRecommendation).toBe("BET_HIGH");
    expect(decision.strength).not.toBe("PASS");
    expect(decision.bestEdge).toBeGreaterThan(0);
    expect(decision.stakeFraction).toBeGreaterThan(0);
  });

  it("bets LOW when the model is meaningfully below the market", () => {
    const decision = makeDecision(
      { ...baseInput, highProbability: 0.55 },
      testConfig(),
    );
    expect(decision.tradeRecommendation).toBe("BET_LOW");
    expect(decision.predictedDirection).toBe("LOW");
    expect(decision.stakeFraction).toBeGreaterThan(0);
  });

  it("grades a bigger disagreement more strongly and stakes more", () => {
    const moderate = makeDecision(
      { ...baseInput, highProbability: 0.78 },
      testConfig(),
    );
    const strong = makeDecision(
      { ...baseInput, highProbability: 0.86 },
      testConfig(),
    );
    expect(strong.bestEdge).toBeGreaterThan(moderate.bestEdge);
    expect(strong.edgeCertainty).toBeGreaterThan(moderate.edgeCertainty);
    expect(strong.stakeFraction).toBeGreaterThanOrEqual(moderate.stakeFraction);
  });

  it("passes when the market already agrees with the model", () => {
    const decision = makeDecision(baseInput, testConfig());
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.strength).toBe("PASS");
    expect(decision.bestEdge).toBeLessThan(0);
    expect(decision.stakeFraction).toBe(0);
  });

  it("still reports a direction and certainty when passing", () => {
    const decision = makeDecision(baseInput, testConfig());
    expect(["HIGH", "LOW"]).toContain(decision.predictedDirection);
    expect(decision.directionCertainty).toBeCloseTo(0.7, 5);
  });

  it("never recommends a bet it cannot size", () => {
    const decision = makeDecision(
      { ...baseInput, highProbability: 0.8, probabilityStdError: 0.2 },
      testConfig(),
    );
    if (decision.tradeRecommendation !== "NO_BET") {
      expect(decision.stakeFraction).toBeGreaterThan(0);
    }
  });

  it("scales the stake down as the estimate gets noisier", () => {
    // Uncapped so the comparison reflects the sizing math rather than the cap.
    const uncapped = testConfig({ maximumStakeFraction: 1 });
    const sharp = makeDecision(
      { ...baseInput, highProbability: 0.82, probabilityStdError: 0.02 },
      uncapped,
    );
    const noisy = makeDecision(
      { ...baseInput, highProbability: 0.82, probabilityStdError: 0.12 },
      uncapped,
    );
    expect(sharp.bestEdge).toBeCloseTo(noisy.bestEdge, 6);
    expect(noisy.stakeFraction).toBeLessThan(sharp.stakeFraction);
  });

  it("caps the stake so one 15-minute market cannot do real damage", () => {
    const decision = makeDecision(
      { ...baseInput, highProbability: 0.98, probabilityStdError: 0.01 },
      testConfig(),
    );
    expect(decision.stakeFraction).toBeLessThanOrEqual(0.02);
  });
});

describe("decision engine — execution blockers", () => {
  const bigEdge = { ...baseInput, highProbability: 0.9 };

  it("refuses to bet on stale data no matter how large the edge", () => {
    const decision = makeDecision(
      { ...bigEdge, dataIsStale: true },
      testConfig({ alwaysPickSide: true }),
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.blockers).toContain("STALE_DATA");
    expect(decision.predictedDirection).toBe("HIGH");
  });

  it("refuses to bet with too little time left", () => {
    const decision = makeDecision({ ...bigEdge, secondsRemaining: 5 }, testConfig());
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.blockers).toContain("WINDOW_CLOSING");
  });

  it("refuses to bet a side with no resting liquidity", () => {
    const decision = makeDecision({ ...bigEdge, yesLiquidity: 0 }, testConfig());
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.blockers).toContain("NO_LIQUIDITY");
  });

  it("falls back to the other side when the best side is unfillable", () => {
    // Model says 20% HIGH, so LOW is the value side; YES has no liquidity but
    // LOW is what we want anyway, and it must remain tradeable.
    const decision = makeDecision(
      { ...baseInput, highProbability: 0.2, yesLiquidity: 0 },
      testConfig(),
    );
    expect(decision.tradeRecommendation).toBe("BET_LOW");
    expect(decision.blockers).toHaveLength(0);
  });

  it("refuses to bet through an unreasonably wide spread", () => {
    const decision = makeDecision(
      { ...bigEdge, yesBid: 0.4, yesAsk: 0.71 },
      testConfig(),
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.blockers).toContain("SPREAD_TOO_WIDE");
  });

  it("explains every blocker in the warnings", () => {
    const decision = makeDecision(
      { ...bigEdge, dataIsStale: true, yesLiquidity: 0 },
      testConfig(),
    );
    expect(decision.warnings).toHaveLength(decision.blockers.length);
    expect(decision.warnings.every((w) => w.length > 0)).toBe(true);
  });

  it("alwaysPickSide never forces a trade through a blocker", () => {
    const decision = makeDecision(
      { ...bigEdge, dataIsStale: true },
      testConfig({ alwaysPickSide: true }),
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.reasons.some((r) => r.includes("If forced to pick a side"))).toBe(
      true,
    );
  });
});

describe("market-implied probability", () => {
  it("averages the YES midpoint with the NO midpoint's complement", () => {
    expect(
      marketImpliedHighProbability({
        yesBid: 0.6,
        yesAsk: 0.64,
        noBid: 0.36,
        noAsk: 0.4,
      }),
    ).toBeCloseTo(0.62, 5);
  });

  it("falls back to a coin flip when both books are unusable", () => {
    expect(
      marketImpliedHighProbability({ yesBid: 0, yesAsk: 0, noBid: 1, noAsk: 1 }),
    ).toBe(0.5);
  });

  it("is what the edge is measured against", () => {
    const decision = makeDecision({ ...baseInput, highProbability: 0.8 }, testConfig());
    expect(decision.marketImpliedHigh).toBeCloseTo(0.7, 5);
    expect(decision.modelDisagreement).toBeCloseTo(0.1, 5);
  });
});
