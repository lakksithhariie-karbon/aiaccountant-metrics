# Hourly Mixpanel sync on Supabase

Date: 2026-09-05
Status: Edge Function live on aia-all. Cron `5 * * * *` UTC. HTTP wait 150s
(`007_cron_http_timeout.sql`) so `pg_net` does not hang up before
`refresh_retention` (~140s). Box loop is fallback until one scheduled hour
is `ok`.

## Goal

Stop depending on this arena box for live data. Mixpanel Raw Export lands in
Supabase `aia-all` (`vphqalgyudaayzswtkac`), then derived retention tables
rebuild in the same project. The Retention app keeps reading `metrics.api` /
`/api/*` only. Dashboards never call Mixpanel.

## Why not daily

The product is already ~60 minutes behind Mixpanel. A once-a-day job would
make the heatmap a day stale. Schedule stays **hourly at minute 5 UTC**, same
as the box cron.

## Pipeline

```
Mixpanel Korefi Prod 3490984 (US, Asia/Kolkata)
        |
        |  GET data.mixpanel.com/api/2.0/export  (yesterday + today, IST dates)
        v
Edge Function  sync-incremental
        |
        |  rpc upsert_mixpanel_events (batches of 500, ON CONFLICT insert_id DO NOTHING)
        |  rpc refresh_retention('public.events')
        |  rpc finish_incremental
        v
public.events  +  six derived tables
        |
        v
metrics.api (4831)  -->  Next web/ (rewrites /api/*)
```

Python `fetcher` stays for prove-day and L6M backfill. It is not the
production hourly path once the Edge Function has run clean for two hours.

## RPCs (migration 004)

| Function | Role |
|---|---|
| `is_internal_email(text)` | Same meaning as `metrics.api.is_internal_email` |
| `try_begin_incremental(lease)` | Single-flight lease on `export_watermarks` job `incremental` |
| `finish_incremental(ok, day, detail)` | Status ok/failed; failed keeps previous `last_success_date` |
| `upsert_mixpanel_events(jsonb)` | Insert parsed rows; conflict on `insert_id` does nothing |
| `refresh_retention(source)` | Truncate + rebuild six derived tables. Source whitelist: `public.events`, `metrics_scratch.events` |

Anon and authenticated cannot execute these. `service_role` can.

`python -m metrics refresh` is a thin caller of `refresh_retention`.

## Calendar

"Today" and "yesterday" are **Asia/Kolkata** dates, not UTC. Mixpanel
`from_date` / `to_date` use those dates. Week math is already IST Monday.

## Concurrency

Do not sleep 120 seconds inside the Edge Function (timeout). Sequential
yesterday-then-today GETs in one invoke. Overlap is blocked by
`try_begin_incremental` (15 minute lease). Do not parallelize Mixpanel
export. If a day returns >= 100k lines, fail the run (current volume ~3.5k).

## Secrets (Edge Function env, never git)

- `MIXPANEL_PROJECT_ID` = `3490984`
- `MIXPANEL_SA_USERNAME`
- `MIXPANEL_SA_SECRET`
- `CRON_SECRET` (invoke header `x-cron-secret`)
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (injected on hosted)

## Cutover

1. `supabase db push --linked` applies 004.
2. Deploy `sync-incremental`, set secrets, schedule `5 * * * *` UTC.
3. Prove two consecutive hours: watermark `ok`, new rows, heatmap KPIs move
   after refresh.
4. Then Operator stops `scripts/incremental_loop.sh` and the box cron.
   Until that, both writers are safe: upsert is idempotent.
