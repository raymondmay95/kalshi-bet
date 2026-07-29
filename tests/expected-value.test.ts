import { describe, expect, it } from "vitest";
import {
  calculateExpectedValue,
  calculateKellyFraction,
  effectiveContractCost,
  feePerContract,
  kalshiFee,
} from "../src/decision/fees.js";

describe("fees and expected value", () => {
  it("calculates Kalshi taker fee with ceiling", () => {
    expect(kalshiFee(0.5, 1)).toBe(0.02);
    expect(kalshiFee(0.9, 1)).toBe(0.01);
  });

  it("amortizes the order-level rounding across the order", () => {
    // The fee is rounded up once per order, so charging it all to a single
    // contract overstates the true per-contract cost.
    expect(feePerContract(0.5, 1)).toBeCloseTo(0.02, 5);
    expect(feePerContract(0.5, 20)).toBeCloseTo(0.0175, 5);
    expect(feePerContract(0.5, 20)).toBeLessThan(feePerContract(0.5, 1));
  });

  it("includes fees and slippage in effective cost", () => {
    const cost = effectiveContractCost(0.57, 20, 0.07, 0.01);
    expect(cost).toBeGreaterThan(0.57);
    expect(cost).toBeCloseTo(0.597, 2);
  });

  it("reports the friction component separately from the price", () => {
    const ev = calculateExpectedValue({
      highProbability: 0.6,
      yesAsk: 0.5,
      noAsk: 0.5,
      assumedOrderSize: 20,
    });
    expect(ev.yesFrictionCost).toBeCloseTo(0.0275, 4);
    expect(ev.effectiveYesCost).toBeCloseTo(0.5275, 4);
  });

  it("sizes a binary bet by edge over profit-if-win", () => {
    // Quarter Kelly on a 4c edge at a 50c all-in cost: 0.25 * 0.04 / 0.5 = 2%.
    expect(calculateKellyFraction(0.04, 0.5, 0.25, 1)).toBeCloseTo(0.02, 6);
    expect(calculateKellyFraction(0.04, 0.5, 0.25, 0.01)).toBe(0.01);
    expect(calculateKellyFraction(-0.01, 0.5)).toBe(0);
    expect(calculateKellyFraction(0.04, 1)).toBe(0);
  });

  it("calculates edge for both sides", () => {
    const ev = calculateExpectedValue({
      highProbability: 0.64,
      yesAsk: 0.57,
      noAsk: 0.45,
      feeCoefficient: 0.07,
      slippage: 0.01,
      assumedOrderSize: 20,
    });

    expect(ev.highEdge).toBeCloseTo(0.05, 1);
    expect(ev.lowEdge).toBeLessThan(ev.highEdge);
  });
});
