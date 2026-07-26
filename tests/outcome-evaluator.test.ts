import { describe, expect, it } from "vitest";
import {
  brierScore,
  evaluateRecommendation,
} from "../src/simulation/outcome-evaluator.js";

describe("outcome evaluator", () => {
  it("marks HIGH correct when result is yes", () => {
    expect(evaluateRecommendation("HIGH", "yes")).toBe(true);
    expect(evaluateRecommendation("HIGH", "no")).toBe(false);
  });

  it("marks LOW correct when result is no", () => {
    expect(evaluateRecommendation("LOW", "no")).toBe(true);
    expect(evaluateRecommendation("LOW", "yes")).toBe(false);
  });

  it("returns null for NO_BET", () => {
    expect(evaluateRecommendation("NO_BET", "yes")).toBeNull();
  });

  it("calculates brier score", () => {
    expect(brierScore(0.64, 1)).toBeCloseTo(0.1296);
  });
});
