-- 003_explorer.sql: client filter + explorer drill tables (Worker A). Pure DDL, no data.
--
-- Signed contract (2026-09-04):
--   Week  = date_trunc('week', event_time AT TIME ZONE 'Asia/Kolkata')
--           (Monday start).
--   Client company = >= 1 event with a non-null, non-empty email that is
--           NOT staff (@karboncard.com / @korefi.ai, case-insensitive,
--           'Name <user@domain>' form, subdomains count). Staff-only
--           companies (has emails, ALL non-null emails internal) are
--           excluded from every derived table. Companies with no email
--           on any row are kept as clients.
--   Activation (company) = first event_name = 'Accounting Sync' with
--           non-null company_id, client companies only.
--   Value events = 'Accounting Sync' OR 'Recon Processed' only.
--   Action events (activity/frequency) = Upload; Mapping Completed;
--           Saved Template Loaded; Invoice Created; Invoice Bulk Edited;
--           Download-Inv; Preview; Transaction Ledger Updated;
--           Transaction Status; Transaction Type Updated;
--           Transaction Configuration Edited; Vendor Mismatch Resolved;
--           Accounting Sync; Recon Processed; Entity Created; Delete;
--           Download; Export. Login, logout, Sign Up, Dashboard Viewed,
--           Widget Clicked, Phone*, Company Created/Updated/Switched,
--           Product Subscription, Billing Intent* are NOT actions.
--   NEVER delete/filter public.events rows; only derived tables filter.
--   events.company is the UUID; display name = properties->>'companyName'.

CREATE TABLE IF NOT EXISTS client_company (
  company_id text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS company_profile (
  company_id text PRIMARY KEY,
  company_name text,
  signed_up_at timestamptz NOT NULL,
  activated_at timestamptz NOT NULL,
  activation_week date NOT NULL,
  first_upload_at timestamptz,
  first_ready_at timestamptz,
  first_sync_at timestamptz,
  first_recon_at timestamptz,
  last_action_at timestamptz,
  action_count int NOT NULL,
  active_weeks int NOT NULL,
  path_had_upload boolean NOT NULL,
  path_had_ready boolean NOT NULL,
  path_had_sync boolean NOT NULL,
  path_had_recon boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS company_profile_activation_week_idx
  ON company_profile (activation_week);

CREATE TABLE IF NOT EXISTS company_week_action (
  company_id text NOT NULL,
  week_start date NOT NULL,
  action_count int NOT NULL,
  upload_count int NOT NULL,
  txn_count int NOT NULL,
  ap_count int NOT NULL,
  sync_count int NOT NULL,
  recon_count int NOT NULL,
  other_action_count int NOT NULL,
  PRIMARY KEY (company_id, week_start)
);
CREATE INDEX IF NOT EXISTS company_week_action_week_idx
  ON company_week_action (week_start);

-- Fetcher role DML-refreshes; it must not CREATE. Skip if the role
-- is absent (local test Postgres). Re-grant the three existing tables
-- too (harmless if already granted).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
      public.client_company,
      public.company_profile,
      public.company_week_action
    TO product_metrics_fetcher;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
      public.company_activation,
      public.company_week_value,
      public.retention_cells
    TO product_metrics_fetcher;
  END IF;
END $$;
