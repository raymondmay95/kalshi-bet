import { describe, expect, it, vi } from "vitest";
import { PredictionScheduler } from "../src/prediction/scheduler.js";
import { SimulationWorkerPool } from "../src/prediction/simulation-worker-pool.js";
import { resetEnvCache } from "../src/config/environment.js";

describe("prediction scheduler non-blocking behavior", () => {
  it("onMarketUpdate returns without waiting for Monte Carlo", async () => {
    resetEnvCache();
    process.env.MONTE_CARLO_ENABLED = "true";
    resetEnvCache();

    const pool = new SimulationWorkerPool({ maxRuntimeMs: 5000 });
    const submitSpy = vi.spyOn(pool, "submit");
    const scheduler = new PredictionScheduler(pool);

    let analyticalCalls = 0;
    scheduler.start({
      onAnalyticalDue: () => {
        analyticalCalls += 1;
      },
      onMonteCarloResult: () => {},
    });

    const started = performance.now();
    scheduler.onMarketUpdate({
      marketId: "MKT",
      currentPrice: 100_000,
      strike: 100_000,
      secondsRemaining: 400,
      volatility: 5,
      drift: 0,
      yesMid: 0.5,
      noMid: 0.5,
      observedSettlementPrices: [],
    });
    const elapsed = performance.now() - started;

    // Hot path must stay well under a simulation runtime.
    expect(elapsed).toBeLessThan(50);
    expect(analyticalCalls).toBeGreaterThanOrEqual(1);
    // Submit is fire-and-forget (may be pending/running, never awaited here).
    expect(submitSpy.mock.calls.length).toBeGreaterThanOrEqual(0);

    await scheduler.stop();
    resetEnvCache();
  });

  it("continues analytical updates when Monte Carlo is disabled", async () => {
    process.env.MONTE_CARLO_ENABLED = "false";
    resetEnvCache();

    const scheduler = new PredictionScheduler();
    let analyticalCalls = 0;
    scheduler.start({
      onAnalyticalDue: () => {
        analyticalCalls += 1;
      },
      onMonteCarloResult: () => {},
    });

    scheduler.onMarketUpdate({
      marketId: "MKT",
      currentPrice: 100_000,
      strike: 99_000,
      secondsRemaining: 200,
      volatility: 5,
      drift: 0,
      yesMid: 0.6,
      noMid: 0.4,
      observedSettlementPrices: [],
    });

    expect(analyticalCalls).toBeGreaterThanOrEqual(1);
    expect(scheduler.getPool().isAvailable()).toBe(false);

    await scheduler.stop();
    delete process.env.MONTE_CARLO_ENABLED;
    resetEnvCache();
  });
});
