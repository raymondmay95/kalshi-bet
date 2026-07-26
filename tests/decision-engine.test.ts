import { describe, expect, it } from "vitest";
import { makeDecision } from "../src/decision/decision-engine.js";

const baseInput = {
  highProbability: 0.68,
  confidence: 0.8,
  yesBid: 0.55,
  yesAsk: 0.57,
  noBid: 0.4,
  noAsk: 0.45,
  yesLiquidity: 100,
  noLiquidity: 100,
  secondsRemaining: 300,
  dataIsStale: false,
  distanceToThresholdBps: 6.5,
  tradeImbalance: 0.2,
  momentum30s: 5,
  momentum3m: 10,
};

describe("decision engine", () => {
  it("returns NO_BET trade for stale data even when alwaysPickSide is true", () => {
    const decision = makeDecision(
      { ...baseInput, dataIsStale: true },
      { ...testConfig(), alwaysPickSide: true },
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.predictedDirection).toBe("HIGH");
  });

  it("returns NO_BET trade when seconds remaining below minimum", () => {
    const decision = makeDecision(
      { ...baseInput, secondsRemaining: 30 },
      { ...testConfig(), alwaysPickSide: true },
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(["HIGH", "LOW"]).toContain(decision.predictedDirection);
  });

  it("returns BET_HIGH when edge exceeds minimum", () => {
    const decision = makeDecision(baseInput, testConfig());
    expect(decision.tradeRecommendation).toBe("BET_HIGH");
    expect(decision.recommendation).toBe("HIGH");
    expect(decision.predictedDirection).toBe("HIGH");
    expect(decision.highEdge).toBeGreaterThan(0.07);
  });

  it("returns BET_LOW when low edge dominates", () => {
    const decision = makeDecision(
      {
        ...baseInput,
        highProbability: 0.35,
        yesBid: 0.65,
        yesAsk: 0.68,
        noBid: 0.3,
        noAsk: 0.25,
      },
      testConfig(),
    );
    expect(decision.tradeRecommendation).toBe("BET_LOW");
    expect(decision.recommendation).toBe("LOW");
    expect(decision.predictedDirection).toBe("LOW");
  });

  it("keeps a directional forecast when edge is insufficient but does not bet", () => {
    const decision = makeDecision(
      {
        ...baseInput,
        highProbability: 0.55,
        yesAsk: 0.54,
        noAsk: 0.48,
      },
      testConfig(),
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(["HIGH", "LOW"]).toContain(decision.predictedDirection);
  });

  it("alwaysPickSide never forces a trade recommendation", () => {
    const decision = makeDecision(
      {
        ...baseInput,
        highProbability: 0.55,
        yesAsk: 0.54,
        noAsk: 0.48,
      },
      { ...testConfig(), alwaysPickSide: true },
    );
    expect(decision.tradeRecommendation).toBe("NO_BET");
    expect(decision.predictedDirection).toBeTruthy();
  });
});

function testConfig() {
  return {
    minimumEdge: 0.07,
    minimumConfidence: 0.7,
    maximumSpread: 0.08,
    minimumSecondsRemaining: 90,
    minimumLiquidity: 10,
    feeCoefficient: 0.07,
    slippage: 0.01,
    alwaysPickSide: true,
  };
}
