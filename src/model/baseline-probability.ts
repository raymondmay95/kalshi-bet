export interface ProbabilityInput {
  currentPrice: number;
  threshold: number;
  secondsRemaining: number;
  volatilityPerSqrtSecond: number;
  minimumVolatility?: number;
}

export interface ProbabilityOutput {
  rawHighProbability: number;
  adjustedHighProbability: number;
  lowProbability: number;
  zScore: number;
  effectiveSeconds: number;
  remainingStdDev: number;
  confidence: number;
}

export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const probability =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - probability : probability;
}

export function effectiveSecondsForSettlement(secondsRemaining: number): number {
  return Math.max(secondsRemaining - 30, 1);
}

export function estimateVolatilityPerSqrtSecond(
  realizedVolatility: number | null | undefined,
  price: number,
): number {
  if (!realizedVolatility || price <= 0) {
    return 0.01;
  }
  return Math.max(realizedVolatility * price, 0.01);
}

export function calculateBaselineProbability(
  input: ProbabilityInput,
  confidenceMultiplier = 0.7,
): ProbabilityOutput {
  const effectiveSeconds = effectiveSecondsForSettlement(input.secondsRemaining);
  const minimumVolatility = input.minimumVolatility ?? 0.01;
  const remainingStdDev = Math.max(
    input.volatilityPerSqrtSecond * Math.sqrt(effectiveSeconds),
    minimumVolatility,
  );

  const zScore =
    remainingStdDev > 0
      ? (input.currentPrice - input.threshold) / remainingStdDev
      : 0;

  const rawHighProbability = clamp(normalCdf(zScore), 0, 1);
  const adjustedHighProbability = clamp(
    0.5 + confidenceMultiplier * (rawHighProbability - 0.5),
    0,
    1,
  );
  const lowProbability = 1 - adjustedHighProbability;

  const distanceFactor = Math.min(
    1,
    Math.abs(zScore) / 3,
  );
  const timeFactor = clamp(1 - effectiveSeconds / 900, 0, 1);
  const confidence = clamp(0.5 + 0.5 * (distanceFactor * 0.7 + timeFactor * 0.3), 0, 1);

  return {
    rawHighProbability,
    adjustedHighProbability,
    lowProbability,
    zScore,
    effectiveSeconds,
    remainingStdDev,
    confidence,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
