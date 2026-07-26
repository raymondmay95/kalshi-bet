import { describe, expect, it } from "vitest";
import { daysAgo } from "../src/storage/retention.js";

describe("retention helpers", () => {
  it("computes cutoffs that preserve recent data", () => {
    const now = new Date("2026-07-25T12:00:00.000Z");
    const cutoff7 = daysAgo(now, 7);
    const cutoff90 = daysAgo(now, 90);

    const recent = new Date("2026-07-24T12:00:00.000Z");
    const old = new Date("2026-01-01T00:00:00.000Z");

    expect(recent.getTime()).toBeGreaterThan(cutoff7.getTime());
    expect(old.getTime()).toBeLessThan(cutoff7.getTime());
    expect(recent.getTime()).toBeGreaterThan(cutoff90.getTime());
    expect(old.getTime()).toBeLessThan(cutoff90.getTime());
  });

  it("zero days means cutoff equals now (no historical retention)", () => {
    const now = new Date("2026-07-25T12:00:00.000Z");
    expect(daysAgo(now, 0).getTime()).toBe(now.getTime());
  });
});
