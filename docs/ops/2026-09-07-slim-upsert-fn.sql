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
