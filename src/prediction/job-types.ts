import type { ShockDistribution } from "./monte-carlo.js";

export interface PredictionJob {
  jobId: string;
  marketId: string;
  inputVersion: number;
  generatedAt: number;
  currentPrice: number;
  strike: number;
  secondsRemaining: number;
  volatility: number;
  drift: number;
  settlementWindowSeconds: number;
  pathCount: number;
  seed: number;
  shockDistribution: ShockDistribution;
  studentTDegreesOfFreedom: number;
  /** Prices already observed in the settlement window. */
  observedSettlementPrices: number[];
}

export interface PredictionJobResult {
  jobId: string;
  marketId: string;
  inputVersion: number;
  highProbability: number;
  lowProbability: number;
  estimatedSettlementAverage: number;
  pathCount: number;
  durationMs: number;
  modelVersion: string;
  stale: boolean;
  error?: string;
}

export type WorkerRequest =
  | { type: "simulate"; job: PredictionJob }
  | { type: "ping" };

export type WorkerResponse =
  | { type: "result"; result: PredictionJobResult }
  | { type: "pong"; ts: number }
  | { type: "error"; jobId?: string; message: string };
