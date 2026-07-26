import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  doublePrecision,
  jsonb,
} from "drizzle-orm/pg-core";

export const marketIntervals = pgTable("market_intervals", {
  id: serial("id").primaryKey(),
  kalshiTicker: text("kalshi_ticker").notNull().unique(),
  threshold: doublePrecision("threshold").notNull(),
  intervalStart: timestamp("interval_start", { withTimezone: true }).notNull(),
  intervalEnd: timestamp("interval_end", { withTimezone: true }).notNull(),
  settlementSource: text("settlement_source").notNull(),
  settlementRule: text("settlement_rule").notNull(),
  openingBasisBps: doublePrecision("opening_basis_bps"),
  finalResult: text("final_result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const marketSnapshots = pgTable("market_snapshots", {
  id: serial("id").primaryKey(),
  marketIntervalId: integer("market_interval_id")
    .notNull()
    .references(() => marketIntervals.id),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  secondsRemaining: integer("seconds_remaining").notNull(),
  btcPrice: doublePrecision("btc_price").notNull(),
  btcBid: doublePrecision("btc_bid").notNull(),
  btcAsk: doublePrecision("btc_ask").notNull(),
  yesBid: doublePrecision("yes_bid").notNull(),
  yesAsk: doublePrecision("yes_ask").notNull(),
  noBid: doublePrecision("no_bid").notNull(),
  noAsk: doublePrecision("no_ask").notNull(),
  binanceFeaturesJson: jsonb("binance_features_json"),
  kalshiFeaturesJson: jsonb("kalshi_features_json"),
});

export const predictions = pgTable("predictions", {
  id: serial("id").primaryKey(),
  marketIntervalId: integer("market_interval_id")
    .notNull()
    .references(() => marketIntervals.id),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  modelVersion: text("model_version").notNull(),
  rawHighProbability: doublePrecision("raw_high_probability").notNull(),
  adjustedHighProbability: doublePrecision("adjusted_high_probability").notNull(),
  highEdge: doublePrecision("high_edge").notNull(),
  lowEdge: doublePrecision("low_edge").notNull(),
  recommendation: text("recommendation").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  reasonCodes: jsonb("reason_codes"),
  secondsRemaining: integer("seconds_remaining"),
  finalResult: text("final_result"),
  actualHigh: doublePrecision("actual_high"),
  recommendationCorrect: integer("recommendation_correct"),
  brierScore: doublePrecision("brier_score"),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
});

export const paperTrades = pgTable("paper_trades", {
  id: serial("id").primaryKey(),
  predictionId: integer("prediction_id")
    .notNull()
    .references(() => predictions.id),
  side: text("side").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  quantity: integer("quantity").notNull(),
  simulatedFees: doublePrecision("simulated_fees").notNull(),
  settlementValue: doublePrecision("settlement_value"),
  profitLoss: doublePrecision("profit_loss"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type MarketInterval = typeof marketIntervals.$inferSelect;
export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type Prediction = typeof predictions.$inferSelect;
export type PaperTrade = typeof paperTrades.$inferSelect;
