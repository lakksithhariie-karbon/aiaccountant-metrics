-- The hosted default statement_timeout is 2 minutes. Retention rebuilds need
-- the Edge Function's available 150-second execution window.
ALTER FUNCTION public.refresh_retention(text)
  SET statement_timeout = '145s';
