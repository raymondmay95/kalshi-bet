import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { logger } from "../config/logger.js";
import type {
  PredictionJob,
  PredictionJobResult,
  WorkerRequest,
  WorkerResponse,
} from "./job-types.js";

export type WorkerPoolState = "starting" | "ready" | "busy" | "unhealthy" | "stopped";

export interface WorkerPoolMetrics {
  state: WorkerPoolState;
  restartCount: number;
  completedJobs: number;
  timedOutJobs: number;
  staleResultsDiscarded: number;
  pendingJobs: number;
  lastDurationMs: number | null;
  lastError: string | null;
  lastCompletedAt: number | null;
}

interface MarketSlot {
  running: PredictionJob | null;
  pending: PredictionJob | null;
  latestAcceptedVersion: number;
}

type ResultHandler = (result: PredictionJobResult) => void;

/**
 * Persistent single-worker pool with at-most-one pending job per market.
 * Newer jobs replace older pending jobs; stale results are discarded.
 */
export class SimulationWorkerPool {
  private worker: Worker | null = null;
  private readonly slots = new Map<string, MarketSlot>();
  private readonly maxRuntimeMs: number;
  private runtimeTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private onResult: ResultHandler | null = null;
  private stopped = false;
  private metrics: WorkerPoolMetrics = {
    state: "stopped",
    restartCount: 0,
    completedJobs: 0,
    timedOutJobs: 0,
    staleResultsDiscarded: 0,
    pendingJobs: 0,
    lastDurationMs: null,
    lastError: null,
    lastCompletedAt: null,
  };

  constructor(options?: { maxRuntimeMs?: number }) {
    this.maxRuntimeMs = options?.maxRuntimeMs ?? 2000;
  }

  setResultHandler(handler: ResultHandler): void {
    this.onResult = handler;
  }

  getMetrics(): WorkerPoolMetrics {
    return {
      ...this.metrics,
      pendingJobs: this.countPending(),
    };
  }

  start(): void {
    if (this.stopped) this.stopped = false;
    this.spawnWorker();
    this.pingTimer = setInterval(() => this.ping(), 15_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    this.pingTimer = null;
    this.runtimeTimer = null;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.metrics.state = "stopped";
  }

  /**
   * Submit or replace a simulation job for a market.
   * Returns whether the job was accepted as running or pending.
   */
  submit(job: PredictionJob): "running" | "pending" | "rejected" {
    if (this.stopped || this.metrics.state === "unhealthy") {
      // Still accept into pending so a restart can drain; unless stopped.
      if (this.stopped) return "rejected";
    }

    let slot = this.slots.get(job.marketId);
    if (!slot) {
      slot = { running: null, pending: null, latestAcceptedVersion: 0 };
      this.slots.set(job.marketId, slot);
    }

    // Ignore older versions than what we already accepted.
    if (job.inputVersion < slot.latestAcceptedVersion) {
      this.metrics.staleResultsDiscarded += 1;
      return "rejected";
    }
    slot.latestAcceptedVersion = job.inputVersion;

    if (!slot.running && this.worker && this.metrics.state !== "unhealthy") {
      this.dispatch(job);
      return "running";
    }

    slot.pending = job;
    this.metrics.pendingJobs = this.countPending();
    return "pending";
  }

  isAvailable(): boolean {
    return (
      !this.stopped &&
      this.worker != null &&
      (this.metrics.state === "ready" || this.metrics.state === "busy")
    );
  }

  private dispatch(job: PredictionJob): void {
    const slot = this.slots.get(job.marketId);
    if (!slot || !this.worker) return;

    slot.running = job;
    slot.pending = null;
    this.metrics.state = "busy";
    this.metrics.pendingJobs = this.countPending();

    const message: WorkerRequest = { type: "simulate", job };
    this.worker.postMessage(message);

    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    this.runtimeTimer = setTimeout(() => {
      logger.warn(
        { jobId: job.jobId, marketId: job.marketId, maxRuntimeMs: this.maxRuntimeMs },
        "Monte Carlo worker timed out; restarting",
      );
      this.metrics.timedOutJobs += 1;
      this.metrics.lastError = "timeout";
      void this.restartWorker();
    }, this.maxRuntimeMs);
  }

  private handleWorkerMessage(message: WorkerResponse): void {
    if (message.type === "pong") {
      if (this.metrics.state === "unhealthy") {
        this.metrics.state = "ready";
      }
      return;
    }

    if (message.type === "error") {
      this.metrics.lastError = message.message;
      logger.error({ err: message.message, jobId: message.jobId }, "Worker error");
      this.clearRunningMatching(message.jobId);
      this.drainNext();
      return;
    }

    if (message.type === "result") {
      if (this.runtimeTimer) {
        clearTimeout(this.runtimeTimer);
        this.runtimeTimer = null;
      }

      const result = message.result;
      const slot = this.slots.get(result.marketId);
      if (!slot) return;

      const running = slot.running;
      slot.running = null;

      const isStale =
        !running ||
        running.jobId !== result.jobId ||
        result.inputVersion < slot.latestAcceptedVersion;

      if (isStale) {
        this.metrics.staleResultsDiscarded += 1;
        result.stale = true;
      } else {
        this.metrics.completedJobs += 1;
        this.metrics.lastDurationMs = result.durationMs;
        this.metrics.lastCompletedAt = Date.now();
        this.metrics.lastError = null;
        this.onResult?.(result);
      }

      this.drainNext();
    }
  }

  private drainNext(): void {
    // Prefer any market with a pending job.
    for (const [marketId, slot] of this.slots) {
      if (slot.pending && !slot.running) {
        const next = slot.pending;
        slot.pending = null;
        if (next.inputVersion < slot.latestAcceptedVersion) {
          this.metrics.staleResultsDiscarded += 1;
          continue;
        }
        this.dispatch(next);
        return;
      }
      // Drop empty slots to avoid unbounded map growth across markets.
      if (!slot.pending && !slot.running) {
        this.slots.delete(marketId);
      }
    }
    this.metrics.state = this.worker ? "ready" : "unhealthy";
    this.metrics.pendingJobs = this.countPending();
  }

  private clearRunningMatching(jobId?: string): void {
    for (const slot of this.slots.values()) {
      if (slot.running && (!jobId || slot.running.jobId === jobId)) {
        slot.running = null;
      }
    }
  }

  private countPending(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.pending) count += 1;
    }
    return count;
  }

  private spawnWorker(): void {
    if (this.stopped) return;
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }

    this.metrics.state = "starting";
    const { filename, execArgv } = resolveWorkerEntry();

    try {
      const worker = new Worker(filename, { execArgv });
      this.worker = worker;

      worker.on("message", (msg: WorkerResponse) => this.handleWorkerMessage(msg));
      worker.on("error", (error) => {
        this.metrics.lastError = error.message;
        this.metrics.state = "unhealthy";
        logger.error({ error }, "Monte Carlo worker error");
      });
      worker.on("exit", (code) => {
        this.worker = null;
        if (this.stopped) return;
        this.metrics.state = "unhealthy";
        this.metrics.lastError = `exit ${code}`;
        logger.warn({ code }, "Monte Carlo worker exited; restarting");
        setTimeout(() => {
          if (!this.stopped) void this.restartWorker();
        }, 250);
      });

      this.metrics.state = "ready";
      logger.info({ filename }, "Monte Carlo worker started");
    } catch (error) {
      this.metrics.state = "unhealthy";
      this.metrics.lastError =
        error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Failed to start Monte Carlo worker");
    }
  }

  private async restartWorker(): Promise<void> {
    if (this.stopped) return;
    this.metrics.restartCount += 1;
    if (this.runtimeTimer) {
      clearTimeout(this.runtimeTimer);
      this.runtimeTimer = null;
    }
    // Preserve pending jobs; clear running so it can be re-queued.
    for (const slot of this.slots.values()) {
      if (slot.running) {
        if (!slot.pending || slot.pending.inputVersion < slot.running.inputVersion) {
          slot.pending = slot.running;
        }
        slot.running = null;
      }
    }
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
    this.spawnWorker();
    this.drainNext();
  }

  private ping(): void {
    if (!this.worker) return;
    const message: WorkerRequest = { type: "ping" };
    this.worker.postMessage(message);
  }
}

function resolveWorkerEntry(): { filename: string; execArgv: string[] } {
  const isTs = import.meta.url.endsWith(".ts");
  const url = new URL(
    isTs ? "./monte-carlo-worker.ts" : "./monte-carlo-worker.js",
    import.meta.url,
  );
  return {
    filename: fileURLToPath(url),
    execArgv: isTs ? ["--import", "tsx"] : [],
  };
}
