-- 010_property_enrichment_ingest.sql
--
-- event_properties.v1 is the only property payload allowed into the
-- warehouse. Identity remains in columns. Existing rows are enriched by a
-- merge-only update and identity columns are never rewritten.

CREATE OR REPLACE FUNCTION public.normalize_event_properties(
  p_event_name text,
  p_properties jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  result jsonb := '{}'::jsonb;
  value text;
  normalized text;
  raw jsonb;
BEGIN
  IF p_properties IS NULL OR jsonb_typeof(p_properties) <> 'object' THEN
    RETURN result;
  END IF;

  value := NULLIF(btrim(p_properties->>'companyName'), '');
  IF value IS NOT NULL THEN
    result := result || jsonb_build_object('companyName', value);
  END IF;

  value := NULLIF(btrim(p_properties->>'type'), '');
  IF value IS NOT NULL THEN
    normalized := lower(value);
    IF normalized = 'gst2b' THEN normalized := 'gstr2b'; END IF;
    result := result || jsonb_build_object('type', normalized);
  END IF;

  value := NULLIF(btrim(p_properties->>'subType'), '');
  normalized := lower(COALESCE(value, ''));
  IF p_event_name = 'Upload' THEN
    IF normalized NOT IN ('bulk', 'single', 'gst_reconciliation') THEN
      normalized := 'bank';
    END IF;
    result := result || jsonb_build_object('subType', normalized);
  ELSIF normalized IS NOT NULL THEN
    result := result || jsonb_build_object('subType', normalized);
  END IF;

  value := NULLIF(btrim(p_properties->>'fileType'), '');
  IF value IS NOT NULL THEN
    result := result || jsonb_build_object('fileType', value);
  END IF;

  value := NULLIF(btrim(p_properties->>'status'), '');
  IF value IS NOT NULL THEN
    normalized := lower(value);
    IF normalized = 'success' THEN
      value := 'Success';
    ELSIF normalized = 'failed' THEN
      value := 'Failed';
    END IF;
    result := result || jsonb_build_object('status', value);
  END IF;

  FOREACH value IN ARRAY ARRAY[
    'source', 'entityType', 'action', 'productCode', 'widgetName',
    'flow', 'method', 'viewSource'
  ]
  LOOP
    normalized := NULLIF(btrim(p_properties->>value), '');
    IF normalized IS NOT NULL THEN
      result := result || jsonb_build_object(value, normalized);
    END IF;
  END LOOP;

  value := NULLIF(btrim(p_properties->>'transactionType'), '');
  IF value IS NOT NULL THEN
    IF value ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
      normalized := value;
    ELSE
      normalized := lower(value);
    END IF;
    result := result || jsonb_build_object('transactionType', normalized);
  END IF;

  raw := p_properties->'isReactivation';
  IF jsonb_typeof(raw) = 'boolean' THEN
    result := result || jsonb_build_object('isReactivation', raw);
  END IF;

  raw := p_properties->'items_count';
  IF jsonb_typeof(raw) = 'number' THEN
    result := result || jsonb_build_object('items_count', raw);
  END IF;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_event_properties(
  p_old jsonb,
  p_new jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(p_old, '{}'::jsonb) || COALESCE(p_new, '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.upsert_mixpanel_events_detail(p_rows jsonb)
RETURNS TABLE (
  inserted integer,
  updated integer,
  identity_mismatches integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  mismatch_count integer;
  inserted_count integer;
  updated_count integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'upsert_mixpanel_events expects a JSON array';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _property_incoming (
    insert_id text PRIMARY KEY,
    event_name text NOT NULL,
    event_time timestamptz NOT NULL,
    distinct_id text NOT NULL,
    user_id text,
    uc_uuid text,
    email text,
    company_id text,
    company text,
    properties jsonb NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE TABLE _property_incoming;

  INSERT INTO _property_incoming (
    insert_id, event_name, event_time, distinct_id, user_id,
    uc_uuid, email, company_id, company, properties
  )
  SELECT DISTINCT ON (row_data.insert_id)
    row_data.insert_id,
    row_data.event_name,
    row_data.event_time,
    row_data.distinct_id,
    row_data.user_id,
    row_data.uc_uuid,
    row_data.email,
    row_data.company_id,
    row_data.company,
    public.normalize_event_properties(row_data.event_name, row_data.properties)
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
      CASE
        WHEN jsonb_typeof(elem->'properties') = 'object'
          THEN elem->'properties'
        ELSE '{}'::jsonb
      END AS properties
    FROM jsonb_array_elements(p_rows) AS elem
  ) AS row_data
  WHERE row_data.insert_id IS NOT NULL
    AND row_data.event_name IS NOT NULL
    AND row_data.event_time IS NOT NULL
  ORDER BY row_data.insert_id, row_data.event_time DESC;

  SELECT count(*)::integer
  INTO mismatch_count
  FROM _property_incoming AS incoming
  JOIN public.events AS existing
    ON existing.insert_id = incoming.insert_id
  WHERE existing.event_name IS DISTINCT FROM incoming.event_name
     OR existing.event_time IS DISTINCT FROM incoming.event_time
     OR existing.distinct_id IS DISTINCT FROM incoming.distinct_id
     OR existing.company_id IS DISTINCT FROM incoming.company_id;

  IF mismatch_count > 10 THEN
    RAISE EXCEPTION 'identity mismatches exceed 10: %', mismatch_count;
  END IF;

  INSERT INTO public.events (
    insert_id, event_name, event_time, distinct_id, user_id,
    uc_uuid, email, company_id, company, properties
  )
  SELECT
    incoming.insert_id, incoming.event_name, incoming.event_time,
    incoming.distinct_id, incoming.user_id, incoming.uc_uuid,
    incoming.email, incoming.company_id, incoming.company,
    incoming.properties
  FROM _property_incoming AS incoming
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.events AS existing
    WHERE existing.insert_id = incoming.insert_id
  )
  ON CONFLICT (insert_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  UPDATE public.events AS existing
  SET properties = public.merge_event_properties(
    existing.properties,
    incoming.properties
  )
  FROM _property_incoming AS incoming
  WHERE existing.insert_id = incoming.insert_id
    AND existing.event_name = incoming.event_name
    AND existing.event_time = incoming.event_time
    AND existing.distinct_id = incoming.distinct_id
    AND existing.company_id IS NOT DISTINCT FROM incoming.company_id
    AND existing.properties IS DISTINCT FROM public.merge_event_properties(
      existing.properties,
      incoming.properties
    );
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  RETURN QUERY SELECT inserted_count, updated_count, mismatch_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_mixpanel_events(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result record;
BEGIN
  SELECT *
  INTO result
  FROM public.upsert_mixpanel_events_detail(p_rows);
  RETURN result.inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_event_properties(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_event_properties(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_mixpanel_events_detail(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb) FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.normalize_event_properties(text, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.merge_event_properties(jsonb, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.upsert_mixpanel_events_detail(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.normalize_event_properties(text, jsonb) FROM authenticated;
    REVOKE ALL ON FUNCTION public.merge_event_properties(jsonb, jsonb) FROM authenticated;
    REVOKE ALL ON FUNCTION public.upsert_mixpanel_events_detail(jsonb) FROM authenticated;
    REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events_detail(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events(jsonb) TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher') THEN
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events_detail(jsonb) TO product_metrics_fetcher;
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events(jsonb) TO product_metrics_fetcher;
  END IF;
END
$roles$;
