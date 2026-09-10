-- 012_company_week_product.sql
--
-- Gate 4 custom-event flags. These are company x IST week facts derived from
-- allowlisted event properties. They are deliberately separate from
-- company_week_action and never create synthetic event rows.

CREATE TABLE IF NOT EXISTS public.company_week_product (
  company_id text NOT NULL,
  week_start date NOT NULL,
  had_uploaded_excel boolean NOT NULL,
  had_ap_active boolean NOT NULL,
  had_txn_active boolean NOT NULL,
  had_gst_recon boolean NOT NULL,
  had_created_bill_or_txn boolean NOT NULL,
  had_bill_upload boolean NOT NULL,
  had_invoice_upload boolean NOT NULL,
  had_statement_upload boolean NOT NULL,
  PRIMARY KEY (company_id, week_start)
);

CREATE INDEX IF NOT EXISTS company_week_product_week_idx
  ON public.company_week_product (week_start);

ALTER TABLE public.company_week_product DISABLE ROW LEVEL SECURITY;

-- Independent QA view over events. The materialized table below is rebuilt
-- from the same formulas, while this view stays available for comparisons.
CREATE OR REPLACE VIEW public.company_week_product_qa AS
WITH flagged AS (
  SELECT
    e.company_id,
    (date_trunc('week', e.event_time AT TIME ZONE 'Asia/Kolkata'))::date
      AS week_start,
    (
      e.event_name = 'Upload'
      AND e.properties->>'type' = 'invoice'
      AND e.properties->>'status' IS DISTINCT FROM 'Failed'
    ) AS had_uploaded_excel,
    (
      (
        e.event_name = 'Entity Created'
        AND e.properties->>'entityType' = 'bill'
      )
      OR (
        e.event_name IN ('Upload', 'Download')
        AND e.properties->>'type' = 'bill'
        AND (
          e.event_name <> 'Upload'
          OR e.properties->>'status' IS DISTINCT FROM 'Failed'
        )
      )
    ) AS had_ap_active,
    (
      (
        e.event_name IN ('Upload', 'Download')
        AND e.properties->>'type' = 'statement'
        AND (
          e.event_name <> 'Upload'
          OR e.properties->>'status' IS DISTINCT FROM 'Failed'
        )
      )
      OR e.event_name IN ('Transaction Status', 'Txn Category Updated')
    ) AS had_txn_active,
    (
      (
        e.event_name = 'Upload'
        AND e.properties->>'type' IN ('gstr2b', 'purchase_register')
        AND e.properties->>'status' IS DISTINCT FROM 'Failed'
      )
      OR e.event_name = 'Recon Processed'
      OR (
        e.event_name = 'Download'
        AND e.properties->>'type' = 'reconciled_excel'
      )
    ) AS had_gst_recon,
    (
      (
        e.event_name = 'Entity Created'
        AND e.properties->>'entityType' = 'bill'
      )
      OR (
        e.event_name = 'Transaction Status'
        AND e.properties->>'status' = 'Accounting Ready'
      )
    ) AS had_created_bill_or_txn,
    (
      e.event_name = 'Upload'
      AND e.properties->>'type' = 'bill'
      AND e.properties->>'status' IS DISTINCT FROM 'Failed'
    ) AS had_bill_upload,
    (
      e.event_name = 'Upload'
      AND e.properties->>'type' = 'invoice'
      AND e.properties->>'status' IS DISTINCT FROM 'Failed'
    ) AS had_invoice_upload,
    (
      e.event_name = 'Upload'
      AND e.properties->>'type' = 'statement'
      AND e.properties->>'status' IS DISTINCT FROM 'Failed'
    ) AS had_statement_upload
  FROM public.events AS e
  WHERE e.company_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.client_company AS c
      WHERE c.company_id = e.company_id
    )
), grouped AS (
  SELECT
    company_id,
    week_start,
    BOOL_OR(had_uploaded_excel) AS had_uploaded_excel,
    BOOL_OR(had_ap_active) AS had_ap_active,
    BOOL_OR(had_txn_active) AS had_txn_active,
    BOOL_OR(had_gst_recon) AS had_gst_recon,
    BOOL_OR(had_created_bill_or_txn) AS had_created_bill_or_txn,
    BOOL_OR(had_bill_upload) AS had_bill_upload,
    BOOL_OR(had_invoice_upload) AS had_invoice_upload,
    BOOL_OR(had_statement_upload) AS had_statement_upload
  FROM flagged
  GROUP BY company_id, week_start
)
SELECT *
FROM grouped
WHERE had_uploaded_excel
   OR had_ap_active
   OR had_txn_active
   OR had_gst_recon
   OR had_created_bill_or_txn
   OR had_bill_upload
   OR had_invoice_upload
   OR had_statement_upload;

-- QA coverage is client-company scoped, matching the materialized flags.
CREATE OR REPLACE VIEW public.upload_type_coverage_qa AS
SELECT
  (date_trunc('week', e.event_time AT TIME ZONE 'Asia/Kolkata'))::date
    AS week_start,
  COUNT(*)::int AS total_uploads,
  COUNT(*) FILTER (
    WHERE NULLIF(btrim(e.properties->>'type'), '') IS NOT NULL
  )::int AS typed_uploads,
  COUNT(*) FILTER (
    WHERE NULLIF(btrim(e.properties->>'type'), '') IS NULL
  )::int AS untyped_uploads,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE NULLIF(btrim(e.properties->>'type'), '') IS NOT NULL
    ) / NULLIF(COUNT(*), 0),
    1
  ) AS coverage_pct
FROM public.events AS e
WHERE e.event_name = 'Upload'
  AND e.company_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.client_company AS c
    WHERE c.company_id = e.company_id
  )
GROUP BY 1;

CREATE OR REPLACE FUNCTION public.refresh_company_week_product(
  p_source text DEFAULT 'public.events'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src text;
  inserted_count integer;
BEGIN
  IF p_source NOT IN ('public.events', 'metrics_scratch.events') THEN
    RAISE EXCEPTION 'refusing unsafe source table name: %', p_source;
  END IF;
  src := p_source;

  TRUNCATE TABLE public.company_week_product;

  EXECUTE format(
    $q$
    WITH flagged AS (
      SELECT
        e.company_id,
        (date_trunc('week', e.event_time AT TIME ZONE 'Asia/Kolkata'))::date
          AS week_start,
        (
          e.event_name = 'Upload'
          AND e.properties->>'type' = 'invoice'
          AND e.properties->>'status' IS DISTINCT FROM 'Failed'
        ) AS had_uploaded_excel,
        (
          (
            e.event_name = 'Entity Created'
            AND e.properties->>'entityType' = 'bill'
          )
          OR (
            e.event_name IN ('Upload', 'Download')
            AND e.properties->>'type' = 'bill'
            AND (
              e.event_name <> 'Upload'
              OR e.properties->>'status' IS DISTINCT FROM 'Failed'
            )
          )
        ) AS had_ap_active,
        (
          (
            e.event_name IN ('Upload', 'Download')
            AND e.properties->>'type' = 'statement'
            AND (
              e.event_name <> 'Upload'
              OR e.properties->>'status' IS DISTINCT FROM 'Failed'
            )
          )
          OR e.event_name IN ('Transaction Status', 'Txn Category Updated')
        ) AS had_txn_active,
        (
          (
            e.event_name = 'Upload'
            AND e.properties->>'type' IN ('gstr2b', 'purchase_register')
            AND e.properties->>'status' IS DISTINCT FROM 'Failed'
          )
          OR e.event_name = 'Recon Processed'
          OR (
            e.event_name = 'Download'
            AND e.properties->>'type' = 'reconciled_excel'
          )
        ) AS had_gst_recon,
        (
          (
            e.event_name = 'Entity Created'
            AND e.properties->>'entityType' = 'bill'
          )
          OR (
            e.event_name = 'Transaction Status'
            AND e.properties->>'status' = 'Accounting Ready'
          )
        ) AS had_created_bill_or_txn,
        (
          e.event_name = 'Upload'
          AND e.properties->>'type' = 'bill'
          AND e.properties->>'status' IS DISTINCT FROM 'Failed'
        ) AS had_bill_upload,
        (
          e.event_name = 'Upload'
          AND e.properties->>'type' = 'invoice'
          AND e.properties->>'status' IS DISTINCT FROM 'Failed'
        ) AS had_invoice_upload,
        (
          e.event_name = 'Upload'
          AND e.properties->>'type' = 'statement'
          AND e.properties->>'status' IS DISTINCT FROM 'Failed'
        ) AS had_statement_upload
      FROM %s AS e
      WHERE e.company_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.client_company AS c
          WHERE c.company_id = e.company_id
        )
    ), grouped AS (
      SELECT
        company_id,
        week_start,
        BOOL_OR(had_uploaded_excel) AS had_uploaded_excel,
        BOOL_OR(had_ap_active) AS had_ap_active,
        BOOL_OR(had_txn_active) AS had_txn_active,
        BOOL_OR(had_gst_recon) AS had_gst_recon,
        BOOL_OR(had_created_bill_or_txn) AS had_created_bill_or_txn,
        BOOL_OR(had_bill_upload) AS had_bill_upload,
        BOOL_OR(had_invoice_upload) AS had_invoice_upload,
        BOOL_OR(had_statement_upload) AS had_statement_upload
      FROM flagged
      GROUP BY company_id, week_start
    )
    INSERT INTO public.company_week_product (
      company_id, week_start,
      had_uploaded_excel, had_ap_active, had_txn_active,
      had_gst_recon, had_created_bill_or_txn,
      had_bill_upload, had_invoice_upload, had_statement_upload
    )
    SELECT
      company_id, week_start,
      had_uploaded_excel, had_ap_active, had_txn_active,
      had_gst_recon, had_created_bill_or_txn,
      had_bill_upload, had_invoice_upload, had_statement_upload
    FROM grouped
    WHERE had_uploaded_excel
       OR had_ap_active
       OR had_txn_active
       OR had_gst_recon
       OR had_created_bill_or_txn
       OR had_bill_upload
       OR had_invoice_upload
       OR had_statement_upload
    $q$, src
  );
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- Keep refresh_retention's six-column result stable. The old implementation
-- remains the signed-table builder; the wrapper adds only the new materialized
-- table after client_company has been rebuilt.
ALTER FUNCTION public.refresh_retention(text)
  RENAME TO refresh_retention_base;

REVOKE ALL ON FUNCTION public.refresh_retention_base(text) FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.refresh_retention_base(text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.refresh_retention_base(text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION public.refresh_retention_base(text) FROM service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher') THEN
    REVOKE ALL ON FUNCTION public.refresh_retention_base(text)
      FROM product_metrics_fetcher;
  END IF;
END
$roles$;

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
  base_result record;
BEGIN
  SELECT *
  INTO base_result
  FROM public.refresh_retention_base(p_source);

  PERFORM public.refresh_company_week_product(p_source);

  RETURN QUERY SELECT
    base_result.n_activation,
    base_result.n_week,
    base_result.n_cells,
    base_result.n_client,
    base_result.n_profile,
    base_result.n_week_action;
END;
$$;

REVOKE ALL ON TABLE
  public.company_week_product,
  public.company_week_product_qa,
  public.upload_type_coverage_qa
FROM PUBLIC;

REVOKE ALL ON FUNCTION public.refresh_company_week_product(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_retention(text) FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.company_week_product,
      public.company_week_product_qa,
      public.upload_type_coverage_qa
    FROM anon;
    REVOKE ALL ON FUNCTION public.refresh_company_week_product(text) FROM anon;
    REVOKE ALL ON FUNCTION public.refresh_retention(text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE
      public.company_week_product,
      public.company_week_product_qa,
      public.upload_type_coverage_qa
    FROM authenticated;
    REVOKE ALL ON FUNCTION public.refresh_company_week_product(text)
      FROM authenticated;
    REVOKE ALL ON FUNCTION public.refresh_retention(text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON TABLE
      public.company_week_product,
      public.company_week_product_qa,
      public.upload_type_coverage_qa
    TO service_role;
    GRANT EXECUTE ON FUNCTION public.refresh_retention(text) TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE
      ON TABLE public.company_week_product
      TO product_metrics_fetcher;
    GRANT SELECT ON TABLE
      public.company_week_product_qa,
      public.upload_type_coverage_qa
    TO product_metrics_fetcher;
    GRANT EXECUTE ON FUNCTION public.refresh_retention(text)
      TO product_metrics_fetcher;
  END IF;
END
$roles$;
