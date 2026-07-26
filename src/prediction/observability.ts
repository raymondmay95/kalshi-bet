export interface EngineMetrics {
  marketDataMessages: number;
  lastMarketDataAt: number | null;
  analyticalPredictionCount: number;
  monteCarloRequestCount: number;
  staleJobsDiscarded: number;
  dbInsertLatencyMs: number | null;
  dbErrors: number;
  reconnectCount: number;
  droppedMarketUpdates: number;
  lastAnalyticalAt: number | null;
  lastMonteCarloAt: number | null;
  worker: {
    state: string;
    restartCount: number;
    pendingJobs: number;
    completedJobs: number;
    timedOutJobs: number;
    lastDurationMs: number | null;
    lastError: string | null;
  };
}

const metrics: EngineMetrics = {
  marketDataMessages: 0,
  lastMarketDataAt: null,
  analyticalPredictionCount: 0,
  monteCarloRequestCount: 0,
  staleJobsDiscarded: 0,
  dbInsertLatencyMs: null,
  dbErrors: 0,
  reconnectCount: 0,
  droppedMarketUpdates: 0,
  lastAnalyticalAt: null,
  lastMonteCarloAt: null,
  worker: {
    state: "stopped",
    restartCount: 0,
    pendingJobs: 0,
    completedJobs: 0,
    timedOutJobs: 0,
    lastDurationMs: null,
    lastError: null,
  },
};

export function getEngineMetrics(): EngineMetrics {
  return metrics;
}

export function noteMarketDataMessage(): void {
  metrics.marketDataMessages += 1;
  metrics.lastMarketDataAt = Date.now();
}

export function noteAnalyticalPrediction(): void {
  metrics.analyticalPredictionCount += 1;
  metrics.lastAnalyticalAt = Date.now();
}

export function noteMonteCarloRequest(): void {
  metrics.monteCarloRequestCount += 1;
}

export function noteMonteCarloComplete(): void {
  metrics.lastMonteCarloAt = Date.now();
}

export function noteStaleJobDiscarded(): void {
  metrics.staleJobsDiscarded += 1;
}

export function noteDbInsertLatency(ms: number): void {
  metrics.dbInsertLatencyMs = ms;
}

export function noteDbError(): void {
  metrics.dbErrors += 1;
}

export function noteReconnect(): void {
  metrics.reconnectCount += 1;
}

export function noteDroppedMarketUpdate(): void {
  metrics.droppedMarketUpdates += 1;
}

export function updateWorkerMetrics(partial: EngineMetrics["worker"]): void {
  metrics.worker = { ...partial };
}
