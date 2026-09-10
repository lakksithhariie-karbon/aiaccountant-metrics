# Free to Pro warehouse cutover

This runbook is for the lift-and-shift only. It keeps public.events
unchanged, copies events only, rebuilds the six derived tables, and leaves
Free read-only after the prove gate.

Run every command from /root/arena/Tazor/product-metrics. Keep the Free
project ref explicit when using supabase db query.

## Preconditions

Set the direct database URLs in the execution environment. Do not commit them.

    export FREE_DATABASE_URL="$SUPABASE_DB_URL"
    export PRO_DATABASE_URL='postgresql://postgres:<encoded-password>@db.<pro-ref>.supabase.co:5432/postgres?sslmode=require'

The password must be percent-encoded in a URL. The # character becomes %23.

The target project must be linked:

    npx supabase link --project-ref <pro-ref> --skip-pooler --password '<pro-password>'

The repository is already initialized. Do not run supabase init.

## Prepare Pro

The historical migrations 005 and 007 contain the Free hostname. They must not
be allowed to register a job on Pro. On an empty target, mark those historical
schedule migrations as applied without executing them, then push the remaining
migrations:

    npx supabase migration repair --linked --status applied 005 007
    npx supabase db push --linked --skip-vault --yes

This applies 001-004, 006, 008, and 009. Migration 009 is intentionally
idempotent and does not register a job while its Vault trio is absent.

Set the password for product_metrics_fetcher through the secret channel. Do
not place it in a migration.

Do not set the Edge/Vault ingest secrets or register a Pro cron before the
prove gate. Migration 009 must leave the target without a job while its Vault
trio is absent.

## Freeze Free

Do this only at the actual cutover:

1. Unschedule sync-incremental-hourly on Free.
2. Record and stop the box scripts/incremental_loop.sh PID.
3. Poll export_watermarks until incremental is not running.
4. Take two event and derived-table snapshots 30 seconds apart.
5. Continue only if both snapshots are stable.

Do not restart the Free loop after this point.

## Copy, rebuild, prove

Copy into an empty Pro public.events table:

    python3 scripts/cutover_copy_events.py copy
    python3 scripts/cutover_copy_events.py rebuild
    python3 scripts/cutover_copy_events.py prove

The copy uses named columns, binary COPY, a repeatable-read Free snapshot,
and bounded memory. It verifies total rows and IST event-day counts. The
rebuild measures refresh_retention() and writes only the successful
incremental watermark with status ok and detail cutover.

The prove command pins the IST week boundary from Free and compares:

- total event rows
- event-day checksum
- client companies
- activated companies
- latest mature Week 8 cell

If any value differs, do not point 4831, Vercel, or writers at Pro.

## Point production

Only after prove passes:

1. Deploy the Function to Pro and set its Edge secrets.
2. Create these Vault secrets on Pro:

       sync_incremental_service_role
       sync_incremental_cron
       sync_incremental_function_url

   The URL value must be:

       https://<pro-ref>.supabase.co/functions/v1/sync-incremental

3. Re-run only the new schedule migration:

       npx supabase db query --linked \
         --file supabase/migrations/009_cron_url_from_vault.sql

   Verify the stored cron command reads the Vault URL, contains no Free
   hostname, and uses the 5 * * * * schedule.
4. Restart 4831 with the Pro direct URL.
5. Update the box .env to Pro, but do not restart the box loop.
6. Set Vercel SUPABASE_DB_URL to the Pro pooler URL using
   product_metrics_fetcher.<pro-ref> on port 6543 and redeploy.
7. Run exactly one authenticated yesterday-plus-today incremental against Pro.
8. Confirm the inserted counts and export_watermarks watermark.
9. Keep Free read-only for seven days.
