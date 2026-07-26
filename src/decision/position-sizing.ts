import { calculateKellyFraction } from "./fees.js";

export interface PositionSizingInput {
  edge: number;
  askPrice: number;
  bankroll: number;
  maximumPositionFraction?: number;
}

export function calculatePositionSize(input: PositionSizingInput): number {
  const maxFraction = input.maximumPositionFraction ?? 0.005;
  const kellyFraction = calculateKellyFraction(input.edge, input.askPrice);
  const fraction = Math.min(kellyFraction, maxFraction);
  return input.bankroll * fraction;
}
