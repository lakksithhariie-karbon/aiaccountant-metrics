-- 008_fetcher_grants_and_rls.sql
-- Pro cutover privileges for the warehouse and refresh path.
--
-- This migration intentionally keeps the lift-and-shift events schema.
-- The fetcher role is created without a password. Set its password through
-- the operator's secret channel after the migration is applied.

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher'
  ) THEN
    CREATE ROLE product_metrics_fetcher LOGIN;
  ELSE
    ALTER ROLE product_metrics_fetcher LOGIN;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO product_metrics_fetcher;

REVOKE ALL ON TABLE
  public.events,
  public.export_watermarks,
  public.client_company,
  public.company_activation,
  public.company_week_value,
  public.retention_cells,
  public.company_profile,
  public.company_week_action
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.events,
  public.export_watermarks
TO product_metrics_fetcher;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.client_company,
  public.company_activation,
  public.company_week_value,
  public.retention_cells,
  public.company_profile,
  public.company_week_action
TO product_metrics_fetcher;

DO $roles$
DECLARE
  warehouse_table text := 'public.events, public.export_watermarks, '
    || 'public.client_company, public.company_activation, '
    || 'public.company_week_value, public.retention_cells, '
    || 'public.company_profile, public.company_week_action';
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE %s FROM %I',
        warehouse_table,
        role_name
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO service_role',
      'public.events, public.export_watermarks'
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %s TO service_role',
      'public.client_company, public.company_activation, '
      || 'public.company_week_value, public.retention_cells, '
      || 'public.company_profile, public.company_week_action'
    );
  END IF;
END
$roles$;

ALTER TABLE IF EXISTS public.events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.export_watermarks DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.client_company DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.company_activation DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.company_week_value DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.retention_cells DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.company_profile DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.company_week_action DISABLE ROW LEVEL SECURITY;

GRANT EXECUTE ON FUNCTION public.is_internal_email(text)
  TO product_metrics_fetcher;
GRANT EXECUTE ON FUNCTION public.try_begin_incremental(interval)
  TO product_metrics_fetcher;
GRANT EXECUTE ON FUNCTION public.finish_incremental(boolean, date, text)
  TO product_metrics_fetcher;
GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events(jsonb)
  TO product_metrics_fetcher;
GRANT EXECUTE ON FUNCTION public.refresh_retention(text)
  TO product_metrics_fetcher;

DO $function_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.is_internal_email(text)
      TO service_role;
    GRANT EXECUTE ON FUNCTION public.try_begin_incremental(interval)
      TO service_role;
    GRANT EXECUTE ON FUNCTION public.finish_incremental(boolean, date, text)
      TO service_role;
    GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events(jsonb)
      TO service_role;
    GRANT EXECUTE ON FUNCTION public.refresh_retention(text)
      TO service_role;
  END IF;
END
$function_roles$;
