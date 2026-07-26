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

export function effectiveContractCost(
  askPrice: number,
  count = 1,
  coefficient = 0.07,
  slippage = 0.01,
): number {
  const feePerContract = kalshiFee(askPrice, count, coefficient) / count;
  return askPrice + feePerContract + slippage;
}

export interface ExpectedValueInput {
  highProbability: number;
  yesAsk: number;
  noAsk: number;
  feeCoefficient?: number;
  slippage?: number;
}

export interface ExpectedValueOutput {
  highEdge: number;
  lowEdge: number;
  effectiveYesCost: number;
  effectiveNoCost: number;
}

export function calculateExpectedValue(
  input: ExpectedValueInput,
): ExpectedValueOutput {
  const coefficient = input.feeCoefficient ?? 0.07;
  const slippage = input.slippage ?? 0.01;
  const effectiveYesCost = effectiveContractCost(
    input.yesAsk,
    1,
    coefficient,
    slippage,
  );
  const effectiveNoCost = effectiveContractCost(
    input.noAsk,
    1,
    coefficient,
    slippage,
  );

  return {
    highEdge: input.highProbability - effectiveYesCost,
    lowEdge: 1 - input.highProbability - effectiveNoCost,
    effectiveYesCost,
    effectiveNoCost,
  };
}

export function calculateKellyFraction(edge: number, askPrice: number): number {
  const profitRatio = 1 - askPrice;
  if (profitRatio <= 0 || edge <= 0) return 0;
  return Math.min(0.25 * (edge / profitRatio), 0.005);
}
