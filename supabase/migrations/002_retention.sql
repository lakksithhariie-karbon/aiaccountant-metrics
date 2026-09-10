-- 002_retention.sql: retention data layer (Worker A). Pure DDL, no data.
--
-- Signed contract (2026-09-04):
--   Week  = date_trunc('week', event_time AT TIME ZONE 'Asia/Kolkata')
--           (Monday start).
--   Activation (company) = first event_name = 'Accounting Sync' with
--           non-null company_id.
--   Value events = 'Accounting Sync' OR 'Recon Processed' only.
--           Dashboard Viewed, Upload, Login, etc. do NOT count.
--   Week-8 retained = activated in week W AND >= 1 value event in
--           calendar week W+8 (not 56 days).
--   Join on company_id; null company_id rows are stored but excluded
--           from company metrics.

CREATE TABLE IF NOT EXISTS company_activation (
  company_id text PRIMARY KEY,
  activated_at timestamptz NOT NULL,
  activation_week date NOT NULL
);
CREATE INDEX IF NOT EXISTS company_activation_week_idx
  ON company_activation (activation_week);

CREATE TABLE IF NOT EXISTS company_week_value (
  company_id text NOT NULL,
  week_start date NOT NULL,
  had_value boolean NOT NULL,
  had_sync boolean NOT NULL,
  had_recon boolean NOT NULL,
  PRIMARY KEY (company_id, week_start)
);
CREATE INDEX IF NOT EXISTS company_week_value_week_idx
  ON company_week_value (week_start);
CREATE INDEX IF NOT EXISTS company_week_value_had_value_idx
  ON company_week_value (week_start) WHERE had_value;

CREATE TABLE IF NOT EXISTS retention_cells (
  cohort_week date NOT NULL,
  rel_week int NOT NULL,
  cohort_size int NOT NULL,
  retained_count int NOT NULL,
  PRIMARY KEY (cohort_week, rel_week),
  CHECK (rel_week BETWEEN 0 AND 8)
);
CREATE INDEX IF NOT EXISTS retention_cells_cohort_idx
  ON retention_cells (cohort_week);

-- Fetcher role DML-refreshes; it must not CREATE. Skip if the role
-- is absent (local test Postgres).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
      public.company_activation,
      public.company_week_value,
      public.retention_cells
    TO product_metrics_fetcher;
  END IF;
END $$;
