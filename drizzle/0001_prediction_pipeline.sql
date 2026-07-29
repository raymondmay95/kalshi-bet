-- Backward-compatible extension of the prediction pipeline schema.
-- Safe to apply on existing databases (ADD COLUMN IF NOT EXISTS).

ALTER TABLE "market_intervals" ADD COLUMN IF NOT EXISTS "settlement_value" double precision;
ALTER TABLE "market_intervals" ADD COLUMN IF NOT EXISTS "settlement_timestamp" timestamp with time zone;

ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "input_timestamp" timestamp with time zone;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "input_version" integer;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "monte_carlo_high_probability" double precision;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "calibrated_high_probability" double precision;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "estimated_settlement_price" double precision;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "strike" double precision;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "predicted_direction" text;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "trade_recommendation" text;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "simulation_path_count" integer;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "simulation_duration_ms" double precision;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "stale_result" boolean DEFAULT false;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "expected_value" double precision;
ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "direction_correct" integer;

CREATE TABLE IF NOT EXISTS "model_metrics" (
  "id" serial PRIMARY KEY NOT NULL,
  "model_version" text NOT NULL,
  "evaluation_period_start" timestamp with time zone NOT NULL,
  "evaluation_period_end" timestamp with time zone NOT NULL,
  "brier_score" double precision,
  "log_loss" double precision,
  "calibration_error" double precision,
  "directional_accuracy" double precision,
  "prediction_count" integer NOT NULL,
  "trade_count" integer DEFAULT 0 NOT NULL,
  "paper_trading_pnl" double precision,
  "fee_adjusted_pnl" double precision,
  "metrics_json" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Created here as well as by drizzle-kit push: the whole file is applied as one
-- implicit transaction, so an ALTER against a missing table would roll back
-- every other statement above.
CREATE TABLE IF NOT EXISTS "model_params" (
  "id" serial PRIMARY KEY NOT NULL,
  "fitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sample_count" integer NOT NULL,
  "calibration_intercept" double precision,
  "calibration_slope" double precision,
  "vol_scale" double precision,
  "metrics_json" jsonb
);

ALTER TABLE "model_params" ADD COLUMN IF NOT EXISTS "basis_offset" double precision;
ALTER TABLE "model_params" ADD COLUMN IF NOT EXISTS "basis_std_dev" double precision;

CREATE INDEX IF NOT EXISTS "market_intervals_final_result_idx" ON "market_intervals" ("final_result");
CREATE INDEX IF NOT EXISTS "market_intervals_interval_end_idx" ON "market_intervals" ("interval_end");
CREATE INDEX IF NOT EXISTS "market_snapshots_interval_ts_idx" ON "market_snapshots" ("market_interval_id","timestamp");
CREATE INDEX IF NOT EXISTS "market_snapshots_timestamp_idx" ON "market_snapshots" ("timestamp");
CREATE INDEX IF NOT EXISTS "predictions_interval_ts_idx" ON "predictions" ("market_interval_id","timestamp");
CREATE INDEX IF NOT EXISTS "predictions_model_version_idx" ON "predictions" ("model_version");
CREATE INDEX IF NOT EXISTS "predictions_timestamp_idx" ON "predictions" ("timestamp");
CREATE INDEX IF NOT EXISTS "model_metrics_model_version_idx" ON "model_metrics" ("model_version");
CREATE INDEX IF NOT EXISTS "model_metrics_created_at_idx" ON "model_metrics" ("created_at");
