import { describe, expect, it } from "vitest";
import {
  calculateExpectedValue,
  effectiveContractCost,
  kalshiFee,
} from "../src/decision/fees.js";

describe("fees and expected value", () => {
  it("calculates Kalshi taker fee with ceiling", () => {
    expect(kalshiFee(0.5, 1)).toBe(0.02);
    expect(kalshiFee(0.9, 1)).toBe(0.01);
  });

  it("includes fees and slippage in effective cost", () => {
    const cost = effectiveContractCost(0.57, 1, 0.07, 0.01);
    expect(cost).toBeGreaterThan(0.57);
    expect(cost).toBeCloseTo(0.59, 1);
  });

  it("calculates edge for both sides", () => {
    const ev = calculateExpectedValue({
      highProbability: 0.64,
      yesAsk: 0.57,
      noAsk: 0.45,
      feeCoefficient: 0.07,
      slippage: 0.01,
    });

    expect(ev.highEdge).toBeCloseTo(0.05, 1);
    expect(ev.lowEdge).toBeLessThan(ev.highEdge);
  });
});
