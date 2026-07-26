export interface PredictionMarketState {
  kalshiTicker: string;
  threshold: number;
  intervalStart: number;
  intervalEnd: number;
  secondsRemaining: number;
  btcPrice: number;
  btcBid: number;
  btcAsk: number;
  distanceToThreshold: number;
  distanceToThresholdBps: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  kalshiNoBid: number;
  kalshiNoAsk: number;
  settlementSource: string;
  dataUpdatedAt: number;
}

export function buildPredictionMarketState(input: {
  kalshiTicker: string;
  threshold: number;
  intervalStart: number;
  intervalEnd: number;
  btcPrice: number;
  btcBid: number;
  btcAsk: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  kalshiNoBid: number;
  kalshiNoAsk: number;
  settlementSource: string;
  now?: number;
}): PredictionMarketState {
  const now = input.now ?? Date.now();
  const secondsRemaining = Math.max(
    0,
    Math.floor((input.intervalEnd - now) / 1000),
  );
  const distanceToThreshold = input.btcPrice - input.threshold;
  const distanceToThresholdBps =
    input.threshold > 0
      ? (distanceToThreshold / input.threshold) * 10_000
      : 0;

  return {
    kalshiTicker: input.kalshiTicker,
    threshold: input.threshold,
    intervalStart: input.intervalStart,
    intervalEnd: input.intervalEnd,
    secondsRemaining,
    btcPrice: input.btcPrice,
    btcBid: input.btcBid,
    btcAsk: input.btcAsk,
    distanceToThreshold,
    distanceToThresholdBps,
    kalshiYesBid: input.kalshiYesBid,
    kalshiYesAsk: input.kalshiYesAsk,
    kalshiNoBid: input.kalshiNoBid,
    kalshiNoAsk: input.kalshiNoAsk,
    settlementSource: input.settlementSource,
    dataUpdatedAt: now,
  };
}

export function formatSnapshotLine(state: PredictionMarketState): string {
  return [
    `ticker=${state.kalshiTicker}`,
    `btc=${state.btcPrice.toFixed(2)}`,
    `strike=${state.threshold.toFixed(2)}`,
    `distBps=${state.distanceToThresholdBps.toFixed(1)}`,
    `t=${state.secondsRemaining}s`,
    `yes=${state.kalshiYesBid.toFixed(2)}/${state.kalshiYesAsk.toFixed(2)}`,
    `no=${state.kalshiNoBid.toFixed(2)}/${state.kalshiNoAsk.toFixed(2)}`,
  ].join(" | ");
}
