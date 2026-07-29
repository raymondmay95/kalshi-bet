import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgresql://kalshi:kalshi@localhost:5432/kalshi_bet"),
  KALSHI_API_BASE: z
    .string()
    .default("https://api.elections.kalshi.com/trade-api/v2"),
  BINANCE_WS_BASE: z
    .string()
    .default("wss://stream.binance.com:9443/ws"),
  BINANCE_REST_BASE: z.string().default("https://api.binance.com"),
  PRICE_FEED: z.enum(["binance", "coinbase"]).default("coinbase"),
  COINBASE_PRODUCT_ID: z.string().default("BTC-USD"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  KALSHI_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  // Edge ladder, in dollars per contract, measured after fees and slippage.
  // The old 7c floor was unreachable because it demanded the model beat the
  // market's own mid by more than the entire spread plus costs. 2c is the
  // smallest floor whose uncertainty-discounted edge is still positive, so Kelly
  // sizes the bet rather than falling through to MINIMUM_STAKE_FRACTION.
  MINIMUM_EDGE: z.coerce.number().default(0.02),
  MODERATE_EDGE: z.coerce.number().default(0.04),
  STRONG_EDGE: z.coerce.number().default(0.07),

  // Minimum P(edge > 0) for each grade, from the probability standard error.
  MINIMUM_EDGE_CERTAINTY: z.coerce.number().default(0.6),
  MODERATE_EDGE_CERTAINTY: z.coerce.number().default(0.7),
  STRONG_EDGE_CERTAINTY: z.coerce.number().default(0.8),

  MAXIMUM_SPREAD: z.coerce.number().default(0.15),
  MINIMUM_SECONDS_REMAINING: z.coerce.number().int().nonnegative().default(20),
  // Matches ASSUMED_ORDER_SIZE: the size the fee math prices must be the size
  // required to be resting, or the engine prices a lot it cannot fill.
  MINIMUM_LIQUIDITY: z.coerce.number().int().nonnegative().default(20),

  // Position sizing
  ASSUMED_ORDER_SIZE: z.coerce.number().int().positive().default(20),
  KELLY_MULTIPLIER: z.coerce.number().positive().default(0.25),
  MAXIMUM_STAKE_FRACTION: z.coerce.number().positive().default(0.02),
  MINIMUM_STAKE_FRACTION: z.coerce.number().positive().default(0.002),

  // Probability uncertainty model
  VOL_RELATIVE_ERROR: z.coerce.number().positive().default(0.3),
  DRIFT_UNCERTAINTY_SHARE: z.coerce.number().nonnegative().default(0.7),
  MODEL_ERROR_FLOOR: z.coerce.number().nonnegative().default(0.02),
  // Replaces MODEL_ERROR_FLOOR once the settlement basis has been measured from
  // settled history, at which point the basis is priced explicitly and this
  // term only has to cover the normal-tail approximation.
  MEASURED_BASIS_ERROR_FLOOR: z.coerce.number().nonnegative().default(0.01),
  BINANCE_STALE_MS: z.coerce.number().int().positive().default(3000),
  KALSHI_STALE_MS: z.coerce.number().int().positive().default(5000),
  PAPER_TRADING: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),
  PAPER_BANKROLL: z.coerce.number().positive().default(1000),
  // MINIMUM_LIQUIDITY guarantees the priced size is resting at the ask, so this
  // covers the quote moving before the fill rather than walking the book.
  SLIPPAGE_CENTS: z.coerce.number().default(0.005),
  TAKER_FEE_COEFFICIENT: z.coerce.number().default(0.07),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default("0.0.0.0"),
  /**
   * When true, forces a directional forecast for evaluation/display.
   * Must never bypass trade-recommendation safety checks.
   */
  ALWAYS_PICK_SIDE: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("true"),

  // Analytical prediction cadence
  ANALYTICAL_PREDICTION_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  ANALYTICAL_PRICE_CHANGE_BPS: z.coerce.number().positive().default(2),
  ANALYTICAL_BOOK_CHANGE: z.coerce.number().positive().default(0.01),

  // Monte Carlo scheduling
  MONTE_CARLO_INTERVAL_NORMAL_MS: z.coerce.number().int().positive().default(30000),
  MONTE_CARLO_INTERVAL_ACTIVE_MS: z.coerce.number().int().positive().default(10000),
  MONTE_CARLO_INTERVAL_FINAL_MS: z.coerce.number().int().positive().default(3000),
  MONTE_CARLO_ACTIVE_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(300),
  MONTE_CARLO_FINAL_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(90),
  MONTE_CARLO_PATHS_FREQUENT: z.coerce.number().int().positive().default(2000),
  MONTE_CARLO_PATHS_NORMAL: z.coerce.number().int().positive().default(5000),
  MONTE_CARLO_PATHS_FINAL: z.coerce.number().int().positive().default(10000),
  MONTE_CARLO_MAX_RUNTIME_MS: z.coerce.number().int().positive().default(2000),
  MONTE_CARLO_SHOCK_DISTRIBUTION: z.enum(["normal", "student-t"]).default("student-t"),
  MONTE_CARLO_STUDENT_T_DF: z.coerce.number().positive().default(5),
  MONTE_CARLO_SETTLEMENT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  MONTE_CARLO_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() !== "false")
    .default("true"),

  // Persistence throttles (Pi-friendly)
  PREDICTION_PERSIST_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // Retention
  RAW_TICK_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  ONE_SECOND_BAR_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  PREDICTION_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(365),
  RETENTION_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Every variable the engine actually reads. Zod silently strips anything else,
 * so a renamed key left behind in `.env` has no effect and no error — the
 * failure mode that kept the old `MINIMUM_CONFIDENCE` looking active.
 */
export function knownEnvKeys(): string[] {
  return Object.keys(envSchema.shape);
}

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}

/** Test helper — clears cached env so process.env changes take effect. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

export const KALSHI_SERIES_TICKER = "KXBTC15M";
