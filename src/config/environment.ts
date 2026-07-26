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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().default(1000),
  KALSHI_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  MINIMUM_EDGE: z.coerce.number().default(0.07),
  MINIMUM_CONFIDENCE: z.coerce.number().default(0.7),
  MAXIMUM_SPREAD: z.coerce.number().default(0.08),
  MINIMUM_SECONDS_REMAINING: z.coerce.number().default(90),
  BINANCE_STALE_MS: z.coerce.number().default(3000),
  KALSHI_STALE_MS: z.coerce.number().default(5000),
  PAPER_TRADING: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("true"),
  SLIPPAGE_CENTS: z.coerce.number().default(0.01),
  TAKER_FEE_COEFFICIENT: z.coerce.number().default(0.07),
  API_PORT: z.coerce.number().default(3001),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}

export const KALSHI_SERIES_TICKER = "KXBTC15M";
