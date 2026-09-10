-- 009_cron_url_from_vault.sql
-- Pro-safe replacement for the historical hard-coded cron migrations.
--
-- The URL is read from Vault at job execution time. There is deliberately no
-- hostname fallback, so a missing or incomplete secret leaves the job absent.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $schedule$
DECLARE
  existing_job bigint;
  required_secrets integer;
  function_url text;
BEGIN
  SELECT jobid
  INTO existing_job
  FROM cron.job
  WHERE jobname = 'sync-incremental-hourly';

  IF existing_job IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job);
  END IF;

  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE NOTICE 'sync-incremental cron not registered: Vault is unavailable';
    RETURN;
  END IF;

  SELECT count(*)
  INTO required_secrets
  FROM vault.decrypted_secrets
  WHERE name IN (
    'sync_incremental_service_role',
    'sync_incremental_cron',
    'sync_incremental_function_url'
  )
    AND decrypted_secret IS NOT NULL
    AND btrim(decrypted_secret) <> '';

  IF required_secrets <> 3 THEN
    RAISE NOTICE
      'sync-incremental cron not registered: required Vault secrets are absent';
    RETURN;
  END IF;

  SELECT decrypted_secret
  INTO function_url
  FROM vault.decrypted_secrets
  WHERE name = 'sync_incremental_function_url';

  IF function_url IS NULL OR function_url !~ '^https://[^[:space:]]+$' THEN
    RAISE NOTICE
      'sync-incremental cron not registered: function URL is invalid';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'sync-incremental-hourly',
    '5 * * * *',
    $job$
      SELECT net.http_post(
        url := (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'sync_incremental_function_url'
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret
            FROM vault.decrypted_secrets
            WHERE name = 'sync_incremental_service_role'
          ),
          'x-cron-secret', (
            SELECT decrypted_secret
            FROM vault.decrypted_secrets
            WHERE name = 'sync_incremental_cron'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
      );
    $job$
  );
END
$schedule$;
