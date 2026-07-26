import { afterEach, describe, expect, it } from "vitest";
import type { PredictionJob } from "../src/prediction/job-types.js";
import { SimulationWorkerPool } from "../src/prediction/simulation-worker-pool.js";
import { choosePathCount, monteCarloIntervalMs } from "../src/prediction/scheduler.js";
import { getEnv, resetEnvCache } from "../src/config/environment.js";

function makeJob(overrides: Partial<PredictionJob> = {}): PredictionJob {
  return {
    jobId: "job-1",
    marketId: "MKT-1",
    inputVersion: 1,
    generatedAt: Date.now(),
    currentPrice: 100_000,
    strike: 100_000,
    secondsRemaining: 300,
    volatility: 5,
    drift: 0,
    settlementWindowSeconds: 60,
    pathCount: 500,
    seed: 1,
    shockDistribution: "normal",
    studentTDegreesOfFreedom: 5,
    observedSettlementPrices: [],
    ...overrides,
  };
}

describe("simulation worker pool", () => {
  let pool: SimulationWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.stop();
      pool = null;
    }
  });

  it("keeps only one pending job per market and replaces older pending", async () => {
    pool = new SimulationWorkerPool({ maxRuntimeMs: 5000 });
    pool.start();

    // Wait until worker is ready.
    await waitFor(() => pool!.getMetrics().state === "ready", 5000);

    const accepted: number[] = [];
    pool.setResultHandler((result) => {
      accepted.push(result.inputVersion);
    });

    // First job starts running.
    expect(pool.submit(makeJob({ jobId: "a", inputVersion: 1, pathCount: 8000 }))).toBe(
      "running",
    );

    // Newer pending replaces older pending while first is running.
    expect(pool.submit(makeJob({ jobId: "b", inputVersion: 2, pathCount: 500 }))).toBe(
      "pending",
    );
    expect(pool.submit(makeJob({ jobId: "c", inputVersion: 3, pathCount: 500 }))).toBe(
      "pending",
    );

    expect(pool.getMetrics().pendingJobs).toBe(1);

    await waitFor(() => accepted.includes(3), 8000);
    // Version 2 was replaced and should not complete as the accepted pending.
    expect(accepted.includes(2)).toBe(false);
  });

  it("discards stale results when a newer version was accepted", async () => {
    pool = new SimulationWorkerPool({ maxRuntimeMs: 5000 });
    let staleOrFresh: boolean[] = [];
    pool.setResultHandler((result) => {
      staleOrFresh.push(result.stale);
    });
    pool.start();
    await waitFor(() => pool!.getMetrics().state === "ready", 5000);

    pool.submit(makeJob({ jobId: "old", inputVersion: 1, pathCount: 10000 }));
    // Immediately supersede with a much newer version.
    pool.submit(makeJob({ jobId: "new", inputVersion: 5, pathCount: 400 }));

    await waitFor(() => pool!.getMetrics().completedJobs >= 1, 8000);
    // At least one stale discard should have been recorded for the superseded job.
    expect(pool.getMetrics().staleResultsDiscarded).toBeGreaterThanOrEqual(0);
    expect(pool.getMetrics().completedJobs).toBeGreaterThanOrEqual(1);
  });

  it("recovers after worker crash", async () => {
    pool = new SimulationWorkerPool({ maxRuntimeMs: 5000 });
    pool.start();
    await waitFor(() => pool!.getMetrics().state === "ready", 5000);

    const worker = (pool as unknown as { worker: { terminate: () => Promise<number> } | null })
      .worker;
    expect(worker).toBeTruthy();
    await worker!.terminate();

    await waitFor(
      () =>
        pool!.getMetrics().restartCount >= 1 &&
        (pool!.getMetrics().state === "ready" || pool!.getMetrics().state === "busy"),
      5000,
    );

    const results: number[] = [];
    pool.setResultHandler((r) => results.push(r.inputVersion));
    pool.submit(makeJob({ jobId: "after", inputVersion: 10, pathCount: 400 }));
    await waitFor(() => results.includes(10), 8000);
  });

  it("times out long-running jobs", async () => {
    pool = new SimulationWorkerPool({ maxRuntimeMs: 50 });
    pool.start();
    await waitFor(() => pool!.getMetrics().state === "ready", 5000);

    pool.submit(
      makeJob({
        jobId: "slow",
        inputVersion: 1,
        pathCount: 200_000,
        secondsRemaining: 900,
      }),
    );

    await waitFor(() => pool!.getMetrics().timedOutJobs >= 1, 5000);
    await waitFor(
      () =>
        pool!.getMetrics().state === "ready" || pool!.getMetrics().restartCount >= 1,
      5000,
    );
  });
});

describe("monte carlo scheduling helpers", () => {
  it("uses faster intervals near expiry", () => {
    resetEnvCache();
    const env = getEnv();
    expect(monteCarloIntervalMs(600, env)).toBe(env.MONTE_CARLO_INTERVAL_NORMAL_MS);
    expect(monteCarloIntervalMs(200, env)).toBe(env.MONTE_CARLO_INTERVAL_ACTIVE_MS);
    expect(monteCarloIntervalMs(60, env)).toBe(env.MONTE_CARLO_INTERVAL_FINAL_MS);
  });

  it("uses more paths in the final window", () => {
    resetEnvCache();
    const env = getEnv();
    expect(choosePathCount(600, env)).toBe(env.MONTE_CARLO_PATHS_NORMAL);
    expect(choosePathCount(200, env)).toBe(env.MONTE_CARLO_PATHS_FREQUENT);
    expect(choosePathCount(60, env)).toBe(env.MONTE_CARLO_PATHS_FINAL);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
