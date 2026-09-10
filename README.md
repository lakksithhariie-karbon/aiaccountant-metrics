# Product metrics fetcher

Copy Korefi Prod Mixpanel events into Postgres. Dashboards should read this copy, not Mixpanel.

This slice is the data plane only. No heatmap, explorer, or scorecard UI.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env
```

Fill `.env` with a Mixpanel **service account that can export events** and a Postgres URL (local Docker or Supabase).

Export `POSTGRES_PASSWORD` in your shell before running this, so the password stays out of your shell history and `ps` output:

```bash
docker run -d --name pm-pg \
  -e POSTGRES_PASSWORD \
  -e POSTGRES_DB=product_metrics \
  -p 5432:5432 postgres:16
```

Schema is applied on first CLI run from `supabase/migrations/001_events.sql`.

## Prove one day

```bash
.venv/bin/python -m fetcher prove-day --date 2026-09-03
```

That hits `https://data.mixpanel.com/api/2.0/export` for project `3490984`. A 401 or 403 means the service account cannot export. Stop and get an export-capable account. Do not retry-loop.

On success you get row count, event names, % with `company_id`, % with a real `$insert_id`, and synthesized-id count. The same day is loaded twice. The second pass must insert 0 rows.

After prove-day, compare a known Sign Up time in the Mixpanel UI vs `event_time` in Postgres and write the offset in `docs/notes/timezone.md`. Mixpanel’s project timezone is Asia/Kolkata; we have not confirmed whether `from_date` is UTC.

## Backfill (L6M)

Window starts `2026-03-04`. Walk one calendar day at a time. Default gap between Mixpanel requests is 120 seconds so we stay under 60 requests/hour.

```bash
.venv/bin/python -m fetcher backfill --from 2026-03-04 --to 2026-09-03
```

If a day returns 100k rows, the job splits by the known 40 event names plus any extra names in the truncated probe. If one event is still over 100k, it splits into 6-hour `where` windows on `properties["time"]` (UTC). A failed day does not advance `export_watermarks`.

## Incremental

Re-pull yesterday and today (Asia/Kolkata dates). Keeps late Mixpanel events. Target: about 60 minutes behind Mixpanel.

Production path: Edge Function `sync-incremental` on Supabase `aia-all` runs hourly at minute 5 UTC (pg_net wait 150s), upserts `public.events`, then calls `refresh_retention`. Spec: `docs/specs/2026-09-05-supabase-incremental.md`. Codex brief: `docs/briefs/2026-09-05-codex-supabase-sync.md`.

Manual / fallback on this box:

```bash
.venv/bin/python -m fetcher incremental
.venv/bin/python -m metrics refresh
```

Hourly fallback: `scripts/incremental_loop.sh` (sleep 3600; keep running until the Edge Function has been proven for two consecutive hours and the Operator cuts over). Cron file: `/etc/cron.d/product-metrics-incremental`. Watermark job name: `incremental`. Logs: `/var/log/pm-incremental.log` or `/tmp/pm-incremental.log`. The box loop does not refresh derived tables; the Edge Function does.

## Feature map

Event names → product areas and activation: `docs/specs/2026-09-04-feature-map.md`. Operator sign-off is required before heatmap work.

## Tests

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics \
  .venv/bin/python -m pytest -v
```

Loader and job tests skip if `TEST_DATABASE_URL` is unset.

## Explorer (cohort retention heatmap)

```bash
.venv/bin/python -m metrics refresh          # calls public.refresh_retention (six derived tables, client companies only)
PORT=4830 .venv/bin/python -m metrics.api    # serve API + web/ on http://127.0.0.1:4830
```

Open http://127.0.0.1:4830, click a week-8 cell for people with nested companies, click a company for path dates + week/event tables + paged timeline.
Staff filter: staff-only companies (every email @karboncard.com/@korefi.ai) are excluded; no-email companies are kept. Actions = upload/mapping/AP/txn/sync/recon/entity/delete/download/export work (never Login, Dashboard, or page views).

## What this does not do

- Composio or Mixpanel Query API
- People / Engage export
- Logging event payloads (email is PII)
- Scorecard tiles
