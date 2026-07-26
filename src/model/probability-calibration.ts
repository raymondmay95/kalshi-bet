export interface ModelVersion {
  name: string;
  version: string;
}

export const BASELINE_MODEL: ModelVersion = {
  name: "baseline-zscore",
  version: "1.0.0",
};

export interface ProbabilityCalibrationInput {
  rawProbability: number;
  confidenceMultiplier?: number;
}

export function shrinkProbability(
  input: ProbabilityCalibrationInput,
): number {
  const multiplier = input.confidenceMultiplier ?? 0.7;
  return 0.5 + multiplier * (input.rawProbability - 0.5);
}
