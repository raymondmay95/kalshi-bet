import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  doublePrecision,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const marketIntervals = pgTable(
  "market_intervals",
  {
    id: serial("id").primaryKey(),
    kalshiTicker: text("kalshi_ticker").notNull().unique(),
    threshold: doublePrecision("threshold").notNull(),
    intervalStart: timestamp("interval_start", { withTimezone: true }).notNull(),
    intervalEnd: timestamp("interval_end", { withTimezone: true }).notNull(),
    settlementSource: text("settlement_source").notNull(),
    settlementRule: text("settlement_rule").notNull(),
    openingBasisBps: doublePrecision("opening_basis_bps"),
    finalResult: text("final_result"),
    settlementValue: doublePrecision("settlement_value"),
    settlementTimestamp: timestamp("settlement_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("market_intervals_final_result_idx").on(table.finalResult),
    index("market_intervals_interval_end_idx").on(table.intervalEnd),
  ],
);

export const marketSnapshots = pgTable(
  "market_snapshots",
  {
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
  },
  (table) => [
    index("market_snapshots_interval_ts_idx").on(
      table.marketIntervalId,
      table.timestamp,
    ),
    index("market_snapshots_timestamp_idx").on(table.timestamp),
  ],
);

export const modelParams = pgTable("model_params", {
  id: serial("id").primaryKey(),
  fittedAt: timestamp("fitted_at", { withTimezone: true }).defaultNow().notNull(),
  sampleCount: integer("sample_count").notNull(),
  // Platt calibration: P = sigmoid(intercept + slope * logit(raw)).
  // Null when the fitted calibration failed walk-forward validation.
  calibrationIntercept: doublePrecision("calibration_intercept"),
  calibrationSlope: doublePrecision("calibration_slope"),
  // Multiplier applied to predicted volatility (std-dev units).
  volScale: doublePrecision("vol_scale"),
  metricsJson: jsonb("metrics_json"),
});

export const predictions = pgTable(
  "predictions",
  {
    id: serial("id").primaryKey(),
    marketIntervalId: integer("market_interval_id")
      .notNull()
      .references(() => marketIntervals.id),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    inputTimestamp: timestamp("input_timestamp", { withTimezone: true }),
    inputVersion: integer("input_version"),
    modelVersion: text("model_version").notNull(),
    rawHighProbability: doublePrecision("raw_high_probability").notNull(),
    adjustedHighProbability: doublePrecision("adjusted_high_probability").notNull(),
    monteCarloHighProbability: doublePrecision("monte_carlo_high_probability"),
    calibratedHighProbability: doublePrecision("calibrated_high_probability"),
    estimatedSettlementPrice: doublePrecision("estimated_settlement_price"),
    strike: doublePrecision("strike"),
    highEdge: doublePrecision("high_edge").notNull(),
    lowEdge: doublePrecision("low_edge").notNull(),
    /** Legacy trade-side field: HIGH | LOW | NO_BET */
    recommendation: text("recommendation").notNull(),
    predictedDirection: text("predicted_direction"),
    tradeRecommendation: text("trade_recommendation"),
    confidence: doublePrecision("confidence").notNull(),
    reasonCodes: jsonb("reason_codes"),
    secondsRemaining: integer("seconds_remaining"),
    // Lock-time model internals, recorded so the learner can train on them.
    btcPrice: doublePrecision("btc_price"),
    remainingStdDev: doublePrecision("remaining_std_dev"),
    zScore: doublePrecision("z_score"),
    appliedDrift: doublePrecision("applied_drift"),
    modelParamsId: integer("model_params_id").references(() => modelParams.id),
    simulationPathCount: integer("simulation_path_count"),
    simulationDurationMs: doublePrecision("simulation_duration_ms"),
    staleResult: boolean("stale_result").default(false),
    expectedValue: doublePrecision("expected_value"),
    finalResult: text("final_result"),
    actualHigh: doublePrecision("actual_high"),
    recommendationCorrect: integer("recommendation_correct"),
    directionCorrect: integer("direction_correct"),
    brierScore: doublePrecision("brier_score"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (table) => [
    index("predictions_interval_ts_idx").on(
      table.marketIntervalId,
      table.timestamp,
    ),
    index("predictions_model_version_idx").on(table.modelVersion),
    index("predictions_timestamp_idx").on(table.timestamp),
  ],
);

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

export const modelMetrics = pgTable(
  "model_metrics",
  {
    id: serial("id").primaryKey(),
    modelVersion: text("model_version").notNull(),
    evaluationPeriodStart: timestamp("evaluation_period_start", {
      withTimezone: true,
    }).notNull(),
    evaluationPeriodEnd: timestamp("evaluation_period_end", {
      withTimezone: true,
    }).notNull(),
    brierScore: doublePrecision("brier_score"),
    logLoss: doublePrecision("log_loss"),
    calibrationError: doublePrecision("calibration_error"),
    directionalAccuracy: doublePrecision("directional_accuracy"),
    predictionCount: integer("prediction_count").notNull(),
    tradeCount: integer("trade_count").notNull().default(0),
    paperTradingPnl: doublePrecision("paper_trading_pnl"),
    feeAdjustedPnl: doublePrecision("fee_adjusted_pnl"),
    metricsJson: jsonb("metrics_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("model_metrics_model_version_idx").on(table.modelVersion),
    index("model_metrics_created_at_idx").on(table.createdAt),
  ],
);

export type ModelParams = typeof modelParams.$inferSelect;
export type MarketInterval = typeof marketIntervals.$inferSelect;
export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type Prediction = typeof predictions.$inferSelect;
export type PaperTrade = typeof paperTrades.$inferSelect;
export type ModelMetric = typeof modelMetrics.$inferSelect;
