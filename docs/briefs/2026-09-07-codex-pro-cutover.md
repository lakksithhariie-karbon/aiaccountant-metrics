# Codex brief: own the Free → Pro warehouse cutover (backend + migration)

Date: 2026-09-07
Owner: Codex (Principal / Staff). You own this end to end: DDL on Pro, copy script, freeze, copy, rebuild, prove, point writers, one incremental. Distinguised Engineer reviews after you report. Operator decides go/no-go if prove fails.
Working directory (hard): `/root/arena/Tazor/product-metrics`
Do not work in sibling dirs. Do not kill **4830**. Do not call Mixpanel except the existing incremental job after Pro is proven. Do not git commit / do not push GitLab unless Operator asks.

Locked plan (Operator + DE + your review). Do not reopen it.

---

## Decision (do not change)

First cutover is a **lift-and-shift** of the current slim `events` table. Not a schema rewrite.

- Copy `public.events` as it exists now (slim `properties` jsonb = `{companyName}` or `{}`, keep `company`).
- Do **not** drop `properties` or `company`. Do **not** add `company_name` on this cutover. That is a later migration after Pro is live 7 days.
- Do **not** re-export 6 months from Mixpanel. Mixpanel is a count check only if you want a second sanity number. Warehouse source of truth for the move is Free `public.events`.
- Copy **every** event, including null `company_id`.
- Do **not** copy derived tables. Rebuild with `refresh_retention('public.events')`.
- `export_watermarks`: copy the incremental **success date** only. Target row must be `status = 'ok'` (or equivalent **not running**). Do not copy a live lease.
- `company` is not equal to `company_id` (~9.4k `Company Switched` rows with UUID in `company` and null `company_id`). Keep the column. Join key remains `company_id`.

Week-8 prove number is **not** 11/53 on 2026-06-29. That is stale. Pin an IST timestamp at freeze and compare Free vs Pro at that instant. Live this morning was about client_company **2175**, activated **778**, week-8 **4/45 (8.9%)** on **2026-07-06**. Use whatever Free reports at freeze, not this paragraph.

---

## Do-nots (hard)

- Do not apply `005_schedule_incremental.sql` or `007_cron_http_timeout.sql` unchanged on Pro. Both hard-code `https://vphqalgyudaayzswtkac.supabase.co/functions/v1/sync-incremental`. Pro cron would keep invoking Free.
- Do not `supabase db dump` the whole Free project (auth, vault, cron, toast).
- Do not copy via dashboard table viewer, Edge Function, or repeated `SELECT *`.
- Do not point Vercel / 4831 at Pro until prove passes.
- Do not leave dual-write aimed at Free after cutover.
- Do not stop 4830.

---

## Source and target

**Source (Free):** project `aia-all`, ref `vphqalgyudaayzswtkac`, org `lakksithhariie`. Connection already in local `.env` as `SUPABASE_DB_URL` (role `product_metrics_fetcher`). Direct host `db.vphqalgyudaayzswtkac.supabase.co`.

**Target (Pro):** org **AI Accountant**, project name **ai accountant (p&e)**, SMALL 2 GB. Empty. Operator created it. **Operator must give you** (ask once if missing):

- project ref
- region
- postgres password (or a `SUPABASE_DB_URL` for Pro)
- pooler string if they use it (`product_metrics_fetcher.<ref>` on `aws-0-<region>.pooler.supabase.com:6543`, `sslmode=require`, `prepare: false`)

Do not reuse the Free connection string. Do not guess the ref.

---

## What you build in the repo

### 1. Grants + RLS for a greenfield project

`001_events.sql` does **not** GRANT `events` / `export_watermarks`. Live Free has those grants anyway. New project will not.

Add `supabase/migrations/008_fetcher_grants_and_rls.sql`:

- `CREATE ROLE` is not your job if dashboard already has `postgres`. Do create `product_metrics_fetcher` if missing (login role, password from Operator / a vault note, not committed).
- `GRANT SELECT, INSERT, UPDATE, DELETE` on `events` and `export_watermarks` to `product_metrics_fetcher`.
- Keep existing derived-table grants from 002/003.
- `GRANT EXECUTE` on the ingest RPCs like 004 already does.
- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` on all eight public warehouse tables (events, watermarks, six derived). Source has `relrowsecurity = false`. Pro was created with auto RLS. No policy + RLS on = fetcher reads 0 rows. Table-owner bypass does not save the fetcher role.

Idempotent. Tests that replay migrations on scratch Postgres must still pass (`IF EXISTS` role).

### 2. Cron URL must not hard-code a project ref

Add `supabase/migrations/009_cron_url_from_vault.sql` (name as you like, one file):

- Unschedule `sync-incremental-hourly` if present.
- Schedule it only when Vault has `sync_incremental_service_role`, `sync_incremental_cron`, **and** `sync_incremental_function_url`.
- `net.http_post` url := that Vault secret (the Pro functions URL). Timeout **150000** ms (keep 007's wait). Body `{}`. Same headers as 007.
- If the URL secret is missing, `RAISE NOTICE` and do not schedule. Never fall back to the Free hostname.

Do not edit 005/007 in place to another hard-coded host. Leave history. New migration is the Pro-safe schedule.

### 3. Cutover script (you run this)

`scripts/cutover_copy_events.py` (or `.sh` + Python). This box is the pipe.

- Env: `FREE_DATABASE_URL` (default current `SUPABASE_DB_URL`), `PRO_DATABASE_URL` (required).
- Stream **named columns** only, no `SELECT *`:
  `insert_id, event_name, event_time, distinct_id, user_id, uc_uuid, email, company_id, company, properties, ingested_at`
- `COPY TO STDOUT` from Free → transform none → `COPY FROM STDIN` to Pro. Do not load 350k rows into RAM.
- `ON CONFLICT` is not available on COPY. Target `events` must be empty. If it is not empty, abort.
- After COPY: `SELECT COUNT(*)` both sides; counts must match. Also per-day `date_trunc('day', event_time AT TIME ZONE 'Asia/Kolkata')` checksum (md5 of day||n or a sorted dump of `(day, n)` ).
- Then on Pro, as a role that can run it: `SELECT * FROM public.refresh_retention('public.events')`. Measure wall time. If it exceeds ~140s, report and bump statement_timeout like 006 before enabling cron. Do not enable cron on a refresh that cannot finish.
- Upsert watermark: `job_name='incremental'`, `last_success_date` = Free's last **ok** date, `status='ok'`, `detail='cutover'`. Not `running`.

TDD: a unit test against scratch that COPYs a handful of seed rows between two schemas or two tables is enough. Do not hit live Mixpanel in tests.

### 4. Freeze / unfreeze runbook in the script or `docs/ops/cutover.md`

You execute it. Short commands, not a novel.

Freeze Free writers, in this order:

1. Unschedule `sync-incremental-hourly` on **Free** (`cron.unschedule`).
2. Stop box `scripts/incremental_loop.sh` (the loop the Operator previously kept as fallback). Record the PID. This is the one time you are allowed to stop it: cutover freeze.
3. Wait until Free `export_watermarks` for `incremental` is not `running` (poll). If stuck running > 15 min, report and stop.
4. Snapshot prove queries on Free (below). Counts must be stable on a second snapshot 30s later.

Do not unfreeze Free ingest after cutover. Free stays read-only 7 days.

---

## Prove queries (run on both DBs, same IST moment)

```sql
SELECT COUNT(*) FROM public.events;
SELECT
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS as_of_ist,
  date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS week_start;
SELECT COUNT(*) FROM client_company;
SELECT COUNT(*) FROM company_activation;
SELECT cohort_week, cohort_size, retained_count
FROM retention_cells
WHERE rel_week = 8
  AND cohort_week <= (date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))::date - 63)
ORDER BY cohort_week DESC
LIMIT 1;
```

Plus `/api/summary` against 4831 **after** you point 4831 at Pro (not before).

Pass bar: events n match; per-day n match; client_company / activated match; week-8 cell match. If any differ, do not point Vercel. Report and stop.

---

## After prove: point writers at Pro

1. Deploy Edge Function `sync-incremental` to **Pro** (same repo folder `supabase/functions/sync-incremental`). Set Pro secrets: Mixpanel SA, `CRON_SECRET`, and the new Vault trio including `sync_incremental_function_url` = `https://<PRO_REF>.supabase.co/functions/v1/sync-incremental`.
2. Apply 009 on Pro so cron posts to **that** URL. Confirm `cron.job` command text contains the Pro ref, not `vphqalgyudaayzswtkac`.
3. Local 4831: restart with Pro `SUPABASE_DB_URL` (fetcher, `sslmode=require`). Leave 4830 on whatever it already is.
4. Box `.env` `SUPABASE_DB_URL` → Pro. Do not start `incremental_loop.sh` again unless Operator asks. Pro cron is the ingest.
5. Vercel project `korefi-product-metrics`: set `SUPABASE_DB_URL` to the **pooler** user `product_metrics_fetcher.<PRO_REF>` (not `postgres`, not the Free ref). `sslmode=require`. Redeploy production. Do not change GitLab remotes unless Operator asks.
6. One `python -m fetcher incremental` against Pro (or one authenticated POST to the Pro function) for yesterday+today IST. Confirm watermark advances.

---

## Files you may change

- `supabase/migrations/008_*.sql`, `009_*.sql` (new)
- `scripts/cutover_copy_events.py` + `docs/ops/cutover.md`
- tests for 008 grants (scratch) and COPY helper
- Edge/cron only as needed to consume Vault URL (no Mixpanel logic rewrite)

Do not change metric meaning in `metrics/api.py` / `web/lib/metrics-server.ts` on this task. Readers still use `properties->>'companyName'`.

---

## Verify (report these)

1. Scratch: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics .venv/bin/python -m pytest tests/test_sync_rpcs.py tests/test_metrics_refresh.py tests/test_api_heatmap.py tests/test_load.py -q` still green after 008/009.
2. Freeze snapshots (Free counts).
3. COPY row count Free = Pro.
4. `refresh_retention` wall time on Pro.
5. Prove query table (Free vs Pro).
6. `cron.job` on Pro: URL host is Pro ref.
7. `curl -sf http://127.0.0.1:4831/api/summary` after 4831 points at Pro.
8. 4830 still up.

If prove fails: leave Vercel on Free, report diffs, do not keep writing to both.

---

## Ask Operator once if missing

Pro project ref, postgres password or Pro `SUPABASE_DB_URL`, confirmation you may unschedule Free cron and stop the box loop. Then run. Do not wait for a second brief.
