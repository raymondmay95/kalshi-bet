export interface RiskState {
  consecutiveLosses: number;
  dailyLoss: number;
}

export interface RiskLimits {
  maxDailyLossFraction: number;
  maxConsecutiveLosses: number;
  bankroll: number;
}

export function shouldStopTrading(
  state: RiskState,
  limits: RiskLimits,
): { stop: boolean; reason?: string } {
  if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return { stop: true, reason: "Maximum consecutive losses reached" };
  }

  const maxDailyLoss = limits.bankroll * limits.maxDailyLossFraction;
  if (state.dailyLoss >= maxDailyLoss) {
    return { stop: true, reason: "Daily loss limit reached" };
  }

  return { stop: false };
}
