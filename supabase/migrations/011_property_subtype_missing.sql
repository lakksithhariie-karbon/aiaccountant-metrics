-- 011_property_subtype_missing.sql
--
-- Keep a missing or empty Mixpanel subType missing. Upload values outside the
-- reviewed buckets remain in the bank bucket, but absence is not a bucket.
-- This intentionally layers over 010 without rewriting its migration.

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
  IF value IS NOT NULL THEN
    normalized := lower(value);
    IF p_event_name = 'Upload'
       AND normalized NOT IN ('bulk', 'single', 'gst_reconciliation') THEN
      normalized := 'bank';
    END IF;
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

