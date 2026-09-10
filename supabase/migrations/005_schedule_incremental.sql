-- Schedule the hosted Edge Function at minute 5 of every UTC hour.
-- The Vault guard keeps local `supabase start` / reset from calling Mixpanel.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $schedule$
DECLARE
  existing_job bigint;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE NOTICE 'sync-incremental cron not registered: Vault is unavailable';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name IN (
      'sync_incremental_service_role',
      'sync_incremental_cron'
    )
  ) THEN
    RAISE NOTICE 'sync-incremental cron not registered: Vault secrets are absent';
    RETURN;
  END IF;

  SELECT jobid
  INTO existing_job
  FROM cron.job
  WHERE jobname = 'sync-incremental-hourly';

  IF existing_job IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job);
  END IF;

  PERFORM cron.schedule(
    'sync-incremental-hourly',
    '5 * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://vphqalgyudaayzswtkac.supabase.co/functions/v1/sync-incremental',
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
        timeout_milliseconds := 120000
      );
    $job$
  );
END
$schedule$;
