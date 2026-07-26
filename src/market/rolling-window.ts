export interface TimestampedValue {
  timestamp: number;
  value: number;
}

export class RollingWindow {
  private values: TimestampedValue[] = [];

  constructor(private readonly windowMs: number) {}

  add(timestamp: number, value: number): void {
    this.values.push({ timestamp, value });
    this.prune(timestamp);
  }

  prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.values.length > 0 && this.values[0]!.timestamp < cutoff) {
      this.values.shift();
    }
  }

  getValues(): TimestampedValue[] {
    return [...this.values];
  }

  getLatest(): TimestampedValue | null {
    return this.values.at(-1) ?? null;
  }

  getOldest(): TimestampedValue | null {
    return this.values[0] ?? null;
  }

  size(): number {
    return this.values.length;
  }
}

export class PriceHistory {
  private readonly windows = new Map<number, RollingWindow>();

  constructor() {
    // Pre-register the standard windows so prices recorded before the
    // first read (e.g. backfilled candles at startup) are not dropped.
    for (const windowMs of new Set([...RETURN_WINDOWS_MS, ...VOL_WINDOWS_MS])) {
      this.windows.set(windowMs, new RollingWindow(windowMs));
    }
  }

  addPrice(timestamp: number, price: number): void {
    for (const window of this.windows.values()) {
      window.add(timestamp, price);
    }
  }

  getWindow(windowMs: number): RollingWindow {
    if (!this.windows.has(windowMs)) {
      this.windows.set(windowMs, new RollingWindow(windowMs));
    }
    return this.windows.get(windowMs)!;
  }

  getReturnBps(windowMs: number, now = Date.now()): number | null {
    const window = this.getWindow(windowMs);
    window.prune(now);
    const latest = window.getLatest();
    const oldest = window.getOldest();
    if (!latest || !oldest || oldest.value <= 0 || latest.value <= 0) {
      return null;
    }
    return Math.log(latest.value / oldest.value) * 10_000;
  }

  getRealizedVolatility(windowMs: number, now = Date.now()): number | null {
    const window = this.getWindow(windowMs);
    window.prune(now);
    const values = window.getValues();
    if (values.length < 2) return null;

    const returns: number[] = [];
    for (let i = 1; i < values.length; i += 1) {
      const prev = values[i - 1]!.value;
      const curr = values[i]!.value;
      if (prev > 0 && curr > 0) {
        returns.push(Math.log(curr / prev));
      }
    }

    if (returns.length === 0) return null;
    return standardDeviation(returns);
  }

  /**
   * Realized volatility of log returns scaled to a per-square-root-second
   * basis: sqrt(sum of squared returns / elapsed seconds).
   *
   * Unlike getRealizedVolatility (per-tick std dev), this is invariant to
   * how many trades arrive per second, so it can be safely projected with
   * the sqrt-of-time rule.
   */
  getRealizedVolatilityPerSqrtSecond(
    windowMs: number,
    now = Date.now(),
  ): number | null {
    const window = this.getWindow(windowMs);
    window.prune(now);
    const values = window.getValues();
    if (values.length < 2) return null;

    const elapsedSeconds =
      (values.at(-1)!.timestamp - values[0]!.timestamp) / 1000;
    if (elapsedSeconds <= 0) return null;

    let sumSquaredReturns = 0;
    let returnCount = 0;
    for (let i = 1; i < values.length; i += 1) {
      const prev = values[i - 1]!.value;
      const curr = values[i]!.value;
      if (prev > 0 && curr > 0) {
        const logReturn = Math.log(curr / prev);
        sumSquaredReturns += logReturn * logReturn;
        returnCount += 1;
      }
    }

    if (returnCount === 0) return null;
    return Math.sqrt(sumSquaredReturns / elapsedSeconds);
  }
}

export function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export const RETURN_WINDOWS_MS = [
  5_000, 15_000, 30_000, 60_000, 180_000, 300_000, 900_000,
] as const;

export const VOL_WINDOWS_MS = [
  30_000, 60_000, 180_000, 300_000, 900_000, 3_600_000,
] as const;
