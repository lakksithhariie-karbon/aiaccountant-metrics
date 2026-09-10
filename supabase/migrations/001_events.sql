CREATE TABLE IF NOT EXISTS events (
  insert_id text PRIMARY KEY,
  event_name text NOT NULL,
  event_time timestamptz NOT NULL,
  distinct_id text NOT NULL,
  user_id text,
  uc_uuid text,
  email text,
  company_id text,
  company text,
  properties jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_event_time_idx ON events (event_time);
CREATE INDEX IF NOT EXISTS events_company_id_event_time_idx ON events (company_id, event_time);
CREATE INDEX IF NOT EXISTS events_distinct_id_event_time_idx ON events (distinct_id, event_time);
CREATE INDEX IF NOT EXISTS events_event_name_event_time_idx ON events (event_name, event_time);

CREATE TABLE IF NOT EXISTS export_watermarks (
  job_name text PRIMARY KEY,
  last_success_date date,
  last_success_at timestamptz,
  status text NOT NULL,
  detail text
);
