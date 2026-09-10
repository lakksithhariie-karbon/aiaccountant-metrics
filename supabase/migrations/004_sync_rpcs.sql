-- 004_sync_rpcs.sql: warehouse RPCs for the hourly Mixpanel sync.
--
-- Edge Function sync-incremental calls these. Python `metrics refresh`
-- calls refresh_retention. Do not put Mixpanel HTTP in SQL.
--
-- Signed contract unchanged from 002/003:
--   Week = date_trunc('week', event_time AT TIME ZONE 'Asia/Kolkata')
--   Activation = first Accounting Sync with non-null company_id
--   Value = Accounting Sync OR Recon Processed
--   Staff domains = karboncard.com / korefi.ai (subdomains count)
--   events.company is the UUID; display name = properties->>'companyName'
--
-- refresh_retention source whitelist:
--   public.events              (live + CLI)
--   metrics_scratch.events     (pytest only)

CREATE OR REPLACE FUNCTION public.is_internal_email(p_email text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  raw text;
  last_lt int;
  last_gt int;
  domain text;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN false;
  END IF;
  raw := lower(btrim(p_email));
  last_lt := CASE
    WHEN strpos(raw, '<') = 0 THEN 0
    ELSE length(raw) - strpos(reverse(raw), '<') + 1
  END;
  last_gt := CASE
    WHEN strpos(raw, '>') = 0 THEN 0
    ELSE length(raw) - strpos(reverse(raw), '>') + 1
  END;
  IF last_lt > 0 AND last_gt > 0 THEN
    raw := btrim(
      substring(
        raw
        FROM last_lt + 1
        FOR GREATEST(last_gt - last_lt - 1, 0)
      )
    );
  END IF;
  IF strpos(raw, '@') = 0 THEN
    RETURN false;
  END IF;
  domain := substring(raw FROM length(raw) - strpos(reverse(raw), '@') + 2);
  RETURN domain IN ('karboncard.com', 'korefi.ai')
      OR domain LIKE '%.karboncard.com'
      OR domain LIKE '%.korefi.ai';
END;
$$;

CREATE OR REPLACE FUNCTION public.try_begin_incremental(
  p_lease interval DEFAULT interval '15 minutes'
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO public.export_watermarks (
    job_name, last_success_date, last_success_at, status, detail
  )
  VALUES ('incremental', NULL, now(), 'running', 'lease')
  ON CONFLICT (job_name) DO UPDATE
    SET status = 'running',
        last_success_at = now(),
        detail = 'lease'
  WHERE public.export_watermarks.status IS DISTINCT FROM 'running'
     OR public.export_watermarks.last_success_at IS NULL
     OR public.export_watermarks.last_success_at < now() - p_lease
  RETURNING true INTO claimed;
  RETURN COALESCE(claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_incremental(
  p_ok boolean,
  p_day date,
  p_detail text
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.export_watermarks
  SET last_success_date = CASE WHEN p_ok THEN p_day ELSE last_success_date END,
      last_success_at = now(),
      status = CASE WHEN p_ok THEN 'ok' ELSE 'failed' END,
      detail = p_detail
  WHERE job_name = 'incremental';
$$;

CREATE OR REPLACE FUNCTION public.upsert_mixpanel_events(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  inserted integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'upsert_mixpanel_events expects a JSON array';
  END IF;
  WITH incoming AS (
    SELECT DISTINCT ON (r.insert_id)
      r.insert_id,
      r.event_name,
      r.event_time,
      r.distinct_id,
      r.user_id,
      r.uc_uuid,
      r.email,
      r.company_id,
      r.company,
      r.properties
    FROM (
      SELECT
        NULLIF(btrim(elem->>'insert_id'), '') AS insert_id,
        NULLIF(btrim(elem->>'event_name'), '') AS event_name,
        (elem->>'event_time')::timestamptz AS event_time,
        COALESCE(elem->>'distinct_id', '') AS distinct_id,
        NULLIF(elem->>'user_id', '') AS user_id,
        NULLIF(elem->>'uc_uuid', '') AS uc_uuid,
        NULLIF(elem->>'email', '') AS email,
        NULLIF(elem->>'company_id', '') AS company_id,
        NULLIF(elem->>'company', '') AS company,
        jsonb_strip_nulls(
          jsonb_build_object(
            'companyName',
            NULLIF(btrim(elem->'properties'->>'companyName'), '')
          )
        ) AS properties
      FROM jsonb_array_elements(p_rows) AS elem
    ) AS r
    WHERE r.insert_id IS NOT NULL
      AND r.event_name IS NOT NULL
      AND r.event_time IS NOT NULL
    ORDER BY r.insert_id
  ),
  written AS (
    INSERT INTO public.events (
      insert_id, event_name, event_time, distinct_id, user_id,
      uc_uuid, email, company_id, company, properties
    )
    SELECT
      insert_id, event_name, event_time, distinct_id, user_id,
      uc_uuid, email, company_id, company, properties
    FROM incoming
    ON CONFLICT (insert_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO inserted FROM written;
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_retention(
  p_source text DEFAULT 'public.events'
)
RETURNS TABLE (
  n_activation int,
  n_week int,
  n_cells int,
  n_client int,
  n_profile int,
  n_week_action int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src text;
BEGIN
  IF p_source NOT IN ('public.events', 'metrics_scratch.events') THEN
    RAISE EXCEPTION 'refusing unsafe source table name: %', p_source;
  END IF;
  src := p_source;

  TRUNCATE TABLE
    public.client_company,
    public.company_activation,
    public.company_week_value,
    public.retention_cells,
    public.company_profile,
    public.company_week_action;

  EXECUTE format(
    $q$
    INSERT INTO public.client_company (company_id)
    SELECT company_id
    FROM %s
    WHERE company_id IS NOT NULL
    GROUP BY company_id
    HAVING COUNT(*) FILTER (
             WHERE email IS NOT NULL AND email <> ''
               AND NOT public.is_internal_email(email)
           ) > 0
        OR COUNT(*) FILTER (
             WHERE email IS NOT NULL AND email <> ''
           ) = 0
    $q$, src
  );

  EXECUTE format(
    $q$
    INSERT INTO public.company_activation
        (company_id, activated_at, activation_week)
    SELECT
        s.company_id,
        MIN(s.event_time) AS activated_at,
        (date_trunc('week', MIN(s.event_time) AT TIME ZONE 'Asia/Kolkata'))::date
            AS activation_week
    FROM %s AS s
    WHERE s.event_name = 'Accounting Sync'
      AND s.company_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.client_company AS c
        WHERE c.company_id = s.company_id
      )
    GROUP BY s.company_id
    $q$, src
  );

  EXECUTE format(
    $q$
    INSERT INTO public.company_week_value
        (company_id, week_start, had_value, had_sync, had_recon)
    SELECT
        s.company_id,
        (date_trunc('week', s.event_time AT TIME ZONE 'Asia/Kolkata'))::date
            AS week_start,
        BOOL_OR(s.event_name IN ('Accounting Sync', 'Recon Processed'))
            AS had_value,
        BOOL_OR(s.event_name = 'Accounting Sync') AS had_sync,
        BOOL_OR(s.event_name = 'Recon Processed') AS had_recon
    FROM %s AS s
    WHERE s.company_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.client_company AS c
        WHERE c.company_id = s.company_id
      )
    GROUP BY s.company_id, week_start
    $q$, src
  );

  INSERT INTO public.retention_cells
      (cohort_week, rel_week, cohort_size, retained_count)
  SELECT
      a.activation_week AS cohort_week,
      g.rel_week AS rel_week,
      COUNT(*) AS cohort_size,
      COUNT(*) FILTER (WHERE w.had_value) AS retained_count
  FROM public.company_activation AS a
  CROSS JOIN generate_series(0, 8) AS g(rel_week)
  LEFT JOIN public.company_week_value AS w
    ON w.company_id = a.company_id
   AND w.week_start = a.activation_week + g.rel_week * 7
  GROUP BY a.activation_week, g.rel_week;

  EXECUTE format(
    $q$
    INSERT INTO public.company_profile (
        company_id, company_name, signed_up_at,
        activated_at, activation_week,
        first_upload_at, first_ready_at, first_sync_at,
        first_recon_at, last_action_at, action_count,
        active_weeks, path_had_upload, path_had_ready,
        path_had_sync, path_had_recon
    )
    SELECT
        a.company_id,
        nm.company_name,
        COALESCE(
            MIN(s.event_time) FILTER (
                WHERE s.event_name = 'Company Created'),
            MIN(s.event_time)
        ) AS signed_up_at,
        a.activated_at,
        a.activation_week,
        MIN(s.event_time) FILTER (
            WHERE s.event_name = 'Upload') AS first_upload_at,
        MIN(s.event_time) FILTER (
            WHERE s.event_name IN (
                'Invoice Created', 'Transaction Ledger Updated'
            )
        ) AS first_ready_at,
        MIN(s.event_time) FILTER (
            WHERE s.event_name = 'Accounting Sync'
        ) AS first_sync_at,
        MIN(s.event_time) FILTER (
            WHERE s.event_name = 'Recon Processed'
        ) AS first_recon_at,
        MAX(s.event_time) FILTER (
            WHERE s.event_name IN (
                'Upload', 'Mapping Completed', 'Saved Template Loaded',
                'Invoice Created', 'Invoice Bulk Edited', 'Download-Inv',
                'Preview', 'Transaction Ledger Updated', 'Transaction Status',
                'Transaction Type Updated',
                'Transaction Configuration Edited',
                'Vendor Mismatch Resolved', 'Accounting Sync',
                'Recon Processed', 'Entity Created', 'Delete',
                'Download', 'Export'
            )
        ) AS last_action_at,
        COUNT(*) FILTER (
            WHERE s.event_name IN (
                'Upload', 'Mapping Completed', 'Saved Template Loaded',
                'Invoice Created', 'Invoice Bulk Edited', 'Download-Inv',
                'Preview', 'Transaction Ledger Updated', 'Transaction Status',
                'Transaction Type Updated',
                'Transaction Configuration Edited',
                'Vendor Mismatch Resolved', 'Accounting Sync',
                'Recon Processed', 'Entity Created', 'Delete',
                'Download', 'Export'
            )
        )::int AS action_count,
        COUNT(DISTINCT
            (date_trunc('week', s.event_time AT TIME ZONE
             'Asia/Kolkata'))::date
        ) FILTER (
            WHERE s.event_name IN (
                'Upload', 'Mapping Completed', 'Saved Template Loaded',
                'Invoice Created', 'Invoice Bulk Edited', 'Download-Inv',
                'Preview', 'Transaction Ledger Updated', 'Transaction Status',
                'Transaction Type Updated',
                'Transaction Configuration Edited',
                'Vendor Mismatch Resolved', 'Accounting Sync',
                'Recon Processed', 'Entity Created', 'Delete',
                'Download', 'Export'
            )
        )::int AS active_weeks,
        COALESCE(BOOL_OR(
            s.event_name = 'Upload'), FALSE) AS path_had_upload,
        COALESCE(BOOL_OR(
            s.event_name IN (
                'Invoice Created', 'Transaction Ledger Updated'
            )
        ), FALSE) AS path_had_ready,
        COALESCE(BOOL_OR(
            s.event_name = 'Accounting Sync'),
            FALSE) AS path_had_sync,
        COALESCE(BOOL_OR(
            s.event_name = 'Recon Processed'),
            FALSE) AS path_had_recon
    FROM public.company_activation AS a
    JOIN %s AS s ON s.company_id = a.company_id
    LEFT JOIN (
        SELECT DISTINCT ON (company_id)
            company_id,
            NULLIF(properties->>'companyName', '') AS company_name
        FROM %s
        WHERE company_id IS NOT NULL
          AND NULLIF(properties->>'companyName', '') IS NOT NULL
        ORDER BY company_id, event_time DESC
    ) AS nm ON nm.company_id = a.company_id
    GROUP BY a.company_id, a.activated_at, a.activation_week,
        nm.company_name
    $q$, src, src
  );

  EXECUTE format(
    $q$
    INSERT INTO public.company_week_action (
        company_id, week_start, action_count, upload_count,
        txn_count, ap_count, sync_count, recon_count,
        other_action_count
    )
    SELECT
        s.company_id,
        (date_trunc('week', s.event_time AT TIME ZONE 'Asia/Kolkata'))::date
            AS week_start,
        COUNT(*)::int AS action_count,
        COUNT(*) FILTER (
            WHERE s.event_name = 'Upload')::int AS upload_count,
        COUNT(*) FILTER (
            WHERE s.event_name IN (
                'Transaction Ledger Updated',
                'Transaction Status',
                'Transaction Type Updated',
                'Transaction Configuration Edited',
                'Vendor Mismatch Resolved'
            )
        )::int AS txn_count,
        COUNT(*) FILTER (
            WHERE s.event_name IN (
                'Invoice Created',
                'Invoice Bulk Edited',
                'Download-Inv',
                'Preview'
            )
        )::int AS ap_count,
        COUNT(*) FILTER (
            WHERE s.event_name = 'Accounting Sync'
        )::int AS sync_count,
        COUNT(*) FILTER (
            WHERE s.event_name = 'Recon Processed'
        )::int AS recon_count,
        COUNT(*) FILTER (
            WHERE s.event_name IN (
                'Mapping Completed',
                'Saved Template Loaded',
                'Entity Created',
                'Delete',
                'Download',
                'Export'
            )
        )::int AS other_action_count
    FROM %s AS s
    WHERE s.company_id IS NOT NULL
      AND s.event_name IN (
          'Upload', 'Mapping Completed', 'Saved Template Loaded',
          'Invoice Created', 'Invoice Bulk Edited', 'Download-Inv',
          'Preview', 'Transaction Ledger Updated', 'Transaction Status',
          'Transaction Type Updated',
          'Transaction Configuration Edited',
          'Vendor Mismatch Resolved', 'Accounting Sync',
          'Recon Processed', 'Entity Created', 'Delete',
          'Download', 'Export'
      )
      AND EXISTS (
        SELECT 1 FROM public.client_company AS c
        WHERE c.company_id = s.company_id
      )
    GROUP BY s.company_id, week_start
    $q$, src
  );

  RETURN QUERY
  SELECT
    (SELECT count(*)::int FROM public.company_activation),
    (SELECT count(*)::int FROM public.company_week_value),
    (SELECT count(*)::int FROM public.retention_cells),
    (SELECT count(*)::int FROM public.client_company),
    (SELECT count(*)::int FROM public.company_profile),
    (SELECT count(*)::int FROM public.company_week_action);
END;
$$;

REVOKE ALL ON FUNCTION public.is_internal_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_begin_incremental(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_incremental(boolean, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_retention(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.is_internal_email(text) FROM anon;
    REVOKE ALL ON FUNCTION public.try_begin_incremental(interval) FROM anon;
    REVOKE ALL ON FUNCTION public.finish_incremental(boolean, date, text) FROM anon;
    REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.refresh_retention(text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.is_internal_email(text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.try_begin_incremental(interval) FROM authenticated;
    REVOKE ALL ON FUNCTION public.finish_incremental(boolean, date, text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb) FROM authenticated;
    REVOKE ALL ON FUNCTION public.refresh_retention(text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.is_internal_email(text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.try_begin_incremental(interval) TO service_role;
    GRANT EXECUTE ON FUNCTION public.finish_incremental(boolean, date, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.refresh_retention(text) TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher') THEN
    GRANT EXECUTE ON FUNCTION public.is_internal_email(text) TO product_metrics_fetcher;
    GRANT EXECUTE ON FUNCTION public.try_begin_incremental(interval) TO product_metrics_fetcher;
    GRANT EXECUTE ON FUNCTION public.finish_incremental(boolean, date, text) TO product_metrics_fetcher;
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events(jsonb) TO product_metrics_fetcher;
    GRANT EXECUTE ON FUNCTION public.refresh_retention(text) TO product_metrics_fetcher;
  END IF;
END $$;
