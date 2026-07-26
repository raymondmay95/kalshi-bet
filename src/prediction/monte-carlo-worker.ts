import { parentPort } from "node:worker_threads";
import type { PredictionJob, WorkerRequest, WorkerResponse } from "./job-types.js";
import { runSettlementMonteCarlo } from "./monte-carlo.js";

if (!parentPort) {
  throw new Error("monte-carlo-worker must be run as a worker thread");
}

const port = parentPort;

port.on("message", (message: WorkerRequest) => {
  try {
    if (message.type === "ping") {
      const response: WorkerResponse = { type: "pong", ts: Date.now() };
      port.postMessage(response);
      return;
    }

    if (message.type === "simulate") {
      const result = simulate(message.job);
      const response: WorkerResponse = { type: "result", result };
      port.postMessage(response);
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: "error",
      jobId: message.type === "simulate" ? message.job.jobId : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

function simulate(job: PredictionJob) {
  const mc = runSettlementMonteCarlo({
    currentPrice: job.currentPrice,
    strike: job.strike,
    secondsRemaining: job.secondsRemaining,
    volatility: job.volatility,
    drift: job.drift,
    settlementWindowSeconds: job.settlementWindowSeconds,
    observedSettlementPrices: job.observedSettlementPrices,
    pathCount: job.pathCount,
    seed: job.seed,
    shockDistribution: job.shockDistribution,
    studentTDegreesOfFreedom: job.studentTDegreesOfFreedom,
  });

  return {
    jobId: job.jobId,
    marketId: job.marketId,
    inputVersion: job.inputVersion,
    highProbability: mc.highProbability,
    lowProbability: mc.lowProbability,
    estimatedSettlementAverage: mc.estimatedSettlementAverage,
    pathCount: mc.pathCount,
    durationMs: mc.durationMs,
    modelVersion: mc.modelVersion,
    stale: false,
  };
}
