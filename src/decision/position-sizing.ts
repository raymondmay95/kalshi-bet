import { calculateKellyFraction } from "./fees.js";

export interface PositionSizingInput {
  /** Edge after fees and slippage, ideally already discounted for estimation error. */
  edge: number;
  /** All-in per-contract cost, not the raw ask. */
  cost: number;
  bankroll: number;
  kellyMultiplier?: number;
  maximumPositionFraction?: number;
}

export interface PositionSize {
  fraction: number;
  dollars: number;
  contracts: number;
}

export function calculatePositionSize(input: PositionSizingInput): PositionSize {
  const fraction = calculateKellyFraction(
    input.edge,
    input.cost,
    input.kellyMultiplier ?? 0.25,
    input.maximumPositionFraction ?? 0.02,
  );
  const dollars = input.bankroll * fraction;
  const contracts = input.cost > 0 ? Math.floor(dollars / input.cost) : 0;
  return { fraction, dollars, contracts };
}
