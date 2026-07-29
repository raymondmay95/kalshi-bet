/**
 * Kalshi taker fee: `ceil(coefficient * contracts * price * (1 - price))`,
 * rounded up to the next cent on the *whole order*, not per contract.
 */
export function kalshiFee(
  price: number,
  count: number,
  coefficient = 0.07,
  multiplier = 1,
): number {
  if (price <= 0 || price >= 1 || count <= 0) return 0;
  const rawFee = multiplier * coefficient * count * price * (1 - price);
  return Math.ceil(rawFee * 100) / 100;
}

/**
 * Order size assumed when converting the order-level fee into a per-contract
 * cost. Pricing a single contract charges the full round-up-to-a-cent to that
 * one contract, which overstates the fee by up to ~1c and was enough on its own
 * to make every market look unprofitable.
 */
export const DEFAULT_ASSUMED_ORDER_SIZE = 20;

export function feePerContract(
  askPrice: number,
  count = DEFAULT_ASSUMED_ORDER_SIZE,
  coefficient = 0.07,
): number {
  if (count <= 0) return 0;
  return kalshiFee(askPrice, count, coefficient) / count;
}

/** All-in per-contract cost of taking the offer: price + fee + expected slippage. */
export function effectiveContractCost(
  askPrice: number,
  count = DEFAULT_ASSUMED_ORDER_SIZE,
  coefficient = 0.07,
  slippage = 0.01,
): number {
  return askPrice + feePerContract(askPrice, count, coefficient) + slippage;
}

export interface ExpectedValueInput {
  highProbability: number;
  yesAsk: number;
  noAsk: number;
  feeCoefficient?: number;
  slippage?: number;
  assumedOrderSize?: number;
}

export interface ExpectedValueOutput {
  highEdge: number;
  lowEdge: number;
  effectiveYesCost: number;
  effectiveNoCost: number;
  /** Per-contract cost of crossing the spread and paying fees, YES side. */
  yesFrictionCost: number;
  noFrictionCost: number;
}

export function calculateExpectedValue(
  input: ExpectedValueInput,
): ExpectedValueOutput {
  const coefficient = input.feeCoefficient ?? 0.07;
  const slippage = input.slippage ?? 0.01;
  const count = input.assumedOrderSize ?? DEFAULT_ASSUMED_ORDER_SIZE;

  const effectiveYesCost = effectiveContractCost(
    input.yesAsk,
    count,
    coefficient,
    slippage,
  );
  const effectiveNoCost = effectiveContractCost(
    input.noAsk,
    count,
    coefficient,
    slippage,
  );

  return {
    highEdge: input.highProbability - effectiveYesCost,
    lowEdge: 1 - input.highProbability - effectiveNoCost,
    effectiveYesCost,
    effectiveNoCost,
    yesFrictionCost: effectiveYesCost - input.yesAsk,
    noFrictionCost: effectiveNoCost - input.noAsk,
  };
}

/**
 * Kelly fraction for a binary contract bought at `cost` that pays $1 on a win.
 * Optimal stake is `edge / (1 - cost)`; the caller scales it down (fractional
 * Kelly) and caps it, because the edge itself is an estimate.
 */
export function calculateKellyFraction(
  edge: number,
  cost: number,
  kellyMultiplier = 0.25,
  maximumFraction = 0.02,
): number {
  const profitIfWin = 1 - cost;
  if (profitIfWin <= 0 || edge <= 0) return 0;
  return Math.min(kellyMultiplier * (edge / profitIfWin), maximumFraction);
}
