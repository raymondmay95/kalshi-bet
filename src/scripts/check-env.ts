/**
 * Audits the effective configuration against the decision gates.
 *
 * Two silent failure modes motivated this: a key renamed in code but left in
 * `.env` is stripped by zod without complaint, and an edge floor can be set so
 * high that no market can ever clear it. Both look like a working engine that
 * simply never finds a bet.
 */
import { readFileSync } from "node:fs";
import { getEnv, knownEnvKeys } from "../config/environment.js";
import { getDefaultDecisionConfig } from "../decision/decision-engine.js";
import { calculateExpectedValue } from "../decision/fees.js";
import { conservativeEdge } from "../model/probability-uncertainty.js";

/** Standard error the uncertainty model typically reports mid-window. */
const TYPICAL_STD_ERROR = 0.03;
/** Representative KXBTC15M spread used to express gates in comparable terms. */
const TYPICAL_SPREAD = 0.04;

function readEnvFileKeys(path: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=")[0]?.trim() ?? "")
    .filter((key) => key.length > 0);
}

function frictionAt(ask: number, config: ReturnType<typeof getDefaultDecisionConfig>): number {
  return calculateExpectedValue({
    highProbability: 0.5,
    yesAsk: ask,
    noAsk: 1 - ask,
    feeCoefficient: config.feeCoefficient,
    slippage: config.slippage,
    assumedOrderSize: config.assumedOrderSize,
  }).yesFrictionCost;
}

const problems: string[] = [];
const notes: string[] = [];

const known = new Set(knownEnvKeys());
const present = readEnvFileKeys(".env");
const ignored = present.filter((key) => !known.has(key));
const missing = readEnvFileKeys(".env.example").filter(
  (key) => known.has(key) && !present.includes(key),
);

console.log("=== Keys in .env the engine does not read ===");
if (ignored.length === 0) {
  console.log("none");
} else {
  for (const key of ignored) {
    console.log(`  ${key} — ignored, has no effect`);
  }
  problems.push(
    `${ignored.length} key(s) in .env are not read by the engine: ${ignored.join(", ")}`,
  );
}

console.log("\n=== Keys in .env.example missing from .env (code default applies) ===");
console.log(missing.length === 0 ? "none" : missing.map((k) => `  ${k}`).join("\n"));

const config = getDefaultDecisionConfig();
const env = getEnv();

console.log("\n=== Effective decision gates ===");
console.log(
  [
    `edge ladder            LEAN ${(config.minimumEdge * 100).toFixed(1)}c / MODERATE ${(config.moderateEdge * 100).toFixed(1)}c / STRONG ${(config.strongEdge * 100).toFixed(1)}c`,
    `edge certainty ladder  ${(config.minimumEdgeCertainty * 100).toFixed(0)}% / ${(config.moderateEdgeCertainty * 100).toFixed(0)}% / ${(config.strongEdgeCertainty * 100).toFixed(0)}%`,
    `max spread             ${(config.maximumSpread * 100).toFixed(0)}c`,
    `min seconds remaining  ${config.minimumSecondsRemaining}s of a 900s window`,
    `min liquidity          ${config.minimumLiquidity} contracts (prices a ${config.assumedOrderSize}-lot)`,
    `friction at 50c ask    ${(frictionAt(0.5, config) * 100).toFixed(2)}c (fee + ${(config.slippage * 100).toFixed(1)}c slippage)`,
  ].join("\n"),
);

console.log("\n=== Reachability of the LEAN floor ===");
const ask = 0.5 + TYPICAL_SPREAD / 2;
const requiredDisagreement = ask + frictionAt(ask, config) + config.minimumEdge - 0.5;
console.log(
  `At a ${(TYPICAL_SPREAD * 100).toFixed(0)}c spread the model must beat the market mid by ` +
    `${(requiredDisagreement * 100).toFixed(1)}c to reach LEAN.`,
);
if (requiredDisagreement > 0.1) {
  problems.push(
    `LEAN needs a ${(requiredDisagreement * 100).toFixed(1)}c disagreement with the market mid — ` +
      `a z-score model on 15m BTC will effectively never produce that. Lower MINIMUM_EDGE.`,
  );
} else if (requiredDisagreement > 0.07) {
  notes.push(
    `LEAN needs a ${(requiredDisagreement * 100).toFixed(1)}c disagreement with the mid — bets will be rare.`,
  );
}

const discounted = conservativeEdge(config.minimumEdge, TYPICAL_STD_ERROR);
console.log(
  `A bet exactly at the floor discounts to ${(discounted * 100).toFixed(1)}c ` +
    `after the half-sigma haircut at a typical ${(TYPICAL_STD_ERROR * 100).toFixed(0)}c standard error.`,
);
if (discounted <= 0) {
  notes.push(
    `MINIMUM_EDGE of ${(config.minimumEdge * 100).toFixed(1)}c discounts to ` +
      `${(discounted * 100).toFixed(1)}c, so Kelly returns zero and every LEAN falls back to ` +
      `MINIMUM_STAKE_FRACTION. Raise MINIMUM_EDGE to about ${((0.5 * TYPICAL_STD_ERROR + 0.005) * 100).toFixed(1)}c for a Kelly-sized stake.`,
  );
}

if (config.minimumLiquidity < config.assumedOrderSize) {
  notes.push(
    `MINIMUM_LIQUIDITY (${config.minimumLiquidity}) is below ASSUMED_ORDER_SIZE ` +
      `(${config.assumedOrderSize}), so the fee math amortizes over more contracts than the ` +
      `book is required to show. Edges are overstated by up to a cent.`,
  );
}

if (config.minimumSecondsRemaining > 60) {
  notes.push(
    `MINIMUM_SECONDS_REMAINING of ${config.minimumSecondsRemaining}s discards the end of every ` +
      `window, which is when the model's read is sharpest.`,
  );
}

if (env.PAPER_TRADING) notes.push("PAPER_TRADING is on — no real orders, simulated fills only.");

console.log("\n=== Findings ===");
if (problems.length === 0 && notes.length === 0) {
  console.log("Configuration is coherent and the LEAN floor is reachable.");
} else {
  for (const problem of problems) console.log(`PROBLEM  ${problem}`);
  for (const note of notes) console.log(`NOTE     ${note}`);
}

process.exitCode = problems.length > 0 ? 1 : 0;
