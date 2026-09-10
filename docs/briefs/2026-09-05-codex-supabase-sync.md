# Codex brief: Supabase hourly sync (Edge Function)

Date: 2026-09-05
Owner: Codex (Principal / Staff). You implement the Edge Function and schedule.
Reviewer: Distinguished Engineer after you report done.
Working directory (hard): `/root/arena/Tazor/product-metrics`
Do not work in sibling dirs.

Operator asked: move the hourly Mixpanel → Supabase ingest off this box and
into this Supabase project, then refresh the tables the Retention app reads.

---

## What is already wired (do not redo)

Migration `supabase/migrations/004_sync_rpcs.sql` is in the repo. Python
`metrics.refresh.rebuild` now calls `public.refresh_retention`. Tests:

`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics .venv/bin/python -m pytest tests/test_metrics_refresh.py tests/test_sync_rpcs.py tests/test_api_heatmap.py -q`

Those must still pass after your work.

Spec: `docs/specs/2026-09-05-supabase-incremental.md`.

RPCs you call (service_role only):

1. `try_begin_incremental` → boolean. If false, HTTP 409 `{ok:false, reason:"lease"}` and stop. Do not fetch Mixpanel.
2. Mixpanel export yesterday + today (IST). Parse. `upsert_mixpanel_events` in batches of **500**.
3. `refresh_retention` with default source `public.events` (omit arg or pass that string).
4. `finish_incremental(true, todayIst, detailJson)` on success.
5. On any failure after a claimed lease: `finish_incremental(false, null, errorText)` then HTTP 500/503.

Do not reimplement refresh SQL in Deno. Do not TRUNCATE from TypeScript.
Do not write a second events table. Do not call Mixpanel from `web/` or `metrics/api.py`.

---

## Do-nots (hard)

- Do not kill **4830**. Do not stop `scripts/incremental_loop.sh`. Dual-write is OK until Operator cuts over.
- Do not git commit unless Operator asks.
- Do not parallelize Mixpanel export. No `Promise.all` of yesterday and today. Yesterday first, then today.
- Do not `sleep(120)` between requests. Edge timeout cannot hold a 120s gap. The lease replaces the box flock.
- Do not implement the Python 6-hour / per-event 100k split. If a day has >= 100000 non-empty JSONL lines, fail the run, finish_incremental failed, include the line count in detail.
- Do not put Mixpanel secrets in git, in SQL, or in `web/`.
- Do not change activation / value / action / staff meaning.
- Do not `verify_jwt = false` without `x-cron-secret`. Require **both** a valid gateway JWT (service_role) **and** header `x-cron-secret` matching `CRON_SECRET`. Anon JWT is public; secret header is the real lock.
- Do not schedule the cron until `supabase functions deploy sync-incremental` has succeeded.
- Do not apply 004 by connecting as `product_metrics_fetcher` (DML only). Use `npx supabase db push --linked --yes` as postgres.

---

## Ports / processes

Leave 4830, 4831, 4832, and the incremental loop alone. You do not need to
restart the API for this work.

---

## Edge Function to build

Path: `supabase/functions/sync-incremental/`

Files:

- `index.ts` — HTTP handler
- `parse.ts` — port of `fetcher/parse.py` (same insert_id rules)
- `export.ts` — Mixpanel Raw Export client
- Deno tests next to them. Golden fixture: `tests/fixtures/sample_day.jsonl` (read from repo root via a relative path or copy the three lines into the function test). Python tests in `tests/test_parse.py` are the contract.

`supabase/config.toml`:

```toml
[functions.sync-incremental]
verify_jwt = true
```

Hosted project is already linked: `aia-all` ref `vphqalgyudaayzswtkac`.

### Handler contract

`POST` (and GET, so pg_cron / Dashboard cron can hit it) `/functions/v1/sync-incremental`

Headers:

- `Authorization: Bearer <service_role JWT>` (gateway)
- `x-cron-secret: <CRON_SECRET>`

If secret missing/wrong: 401 `{ok:false}` with no Mixpanel call.

Body: ignore, or optional `{ "today": "YYYY-MM-DD" }` **only** for a documented dry-run in local `supabase functions serve`. Production schedule sends no body. Default today = calendar date in `Asia/Kolkata`. Yesterday = that date minus 1 day.

Success 200:

```json
{
  "ok": true,
  "today": "2026-09-05",
  "yesterday": "2026-09-04",
  "days": [
    {"day": "2026-09-04", "rows": 3488, "inserted": 0, "requests": 1},
    {"day": "2026-09-05", "rows": 3495, "inserted": 18, "requests": 1}
  ],
  "refresh": {
    "n_activation": 775,
    "n_week": 0,
    "n_cells": 0,
    "n_client": 2159,
    "n_profile": 0,
    "n_week_action": 0
  }
}
```

(Use the actual refresh return columns. Do not hardcode those numbers.)

### Mixpanel export

URL: `https://data.mixpanel.com/api/2.0/export`

Query: `project_id`, `from_date`, `to_date` (same day), `time_in_ms=true`.

Auth: HTTP Basic `MIXPANEL_SA_USERNAME` / `MIXPANEL_SA_SECRET`.

Header: `Accept-Encoding: gzip`.

Timeout: 120s per request.

401/403: fail the job (no retry loop). 429: retry up to 5 times, backoff `min(30, 2**attempt)` seconds. Other 4xx/5xx: fail.

Project id from env, default `3490984`.

### Parse (must match Python)

Port `fetcher/parse.py` line for line:

- `event` → `event_name`
- `properties.time` required; if `> 1e12` divide by 1000; UTC timestamptz
- `$insert_id` if present, else `syn_` + first 24 hex chars of sha256 of canonical JSON `{event, distinct_id, time, companyId, userId}` with `userId` = `userId || $user_id`, `sort_keys=True`, `default=str` like Python `json.dumps`
- `distinct_id`, `$user_id` else `userId`, `ucUuid`, `email`, `companyId` as text (stringify numbers), `company`
- Skip blank JSONL lines
- Upsert payload fields: `insert_id, event_name, event_time` (ISO), `distinct_id, user_id, uc_uuid, email, company_id, company, properties` (the Mixpanel properties object)

Deno tests must cover the three fixture lines in `tests/fixtures/sample_day.jsonl`: real insert_id, numeric companyId → `"99"`, synthesized `syn_` stable.

### Upsert

`supabase.rpc('upsert_mixpanel_events', { p_rows: batch })` with the service role client. Batches of 500. Sum returned integers as `inserted`.

Empty day (0 lines) is success: inserted 0, still proceed to the other day and to refresh.

### Refresh

After both days upsert: `supabase.rpc('refresh_retention', { p_source: 'public.events' })`.

This is a full rebuild (TRUNCATE derived tables). It can take tens of seconds on aia-all. Do not time out the function at 10s. If the platform limit is 150s wall and refresh overruns, report that as a blocker with timings. Do not invent a partial refresh.

### Lease / watermark

Job name is already `incremental` (same row the Python fetcher uses). Claiming the lease sets status `running`. Python incremental on this box may collide: if it holds the row as `ok` you still claim; if Edge holds `running`, Python `set_watermark` can overwrite. Accept that until cutover. Do not change Python fetcher in this brief.

---

## Deploy steps (you run these)

1. `npx supabase db push --linked --yes` so 004 exists on aia-all. If denied, stop and report. Do not CREATE as fetcher.
2. Create function files. Deno tests green locally (`deno test` in the function dir, or `supabase functions serve` + a fixture replay).
3. `npx supabase secrets set` for `MIXPANEL_PROJECT_ID`, `MIXPANEL_SA_USERNAME`, `MIXPANEL_SA_SECRET`, `CRON_SECRET`. Copy Mixpanel values from the existing project `.env` (do not print them). Generate `CRON_SECRET` yourself; put the same value in the cron header. Do not echo secrets into logs or the report.
4. `npx supabase functions deploy sync-incremental --linked`.
5. Schedule hourly `5 * * * *` UTC (same as `/etc/cron.d/product-metrics-incremental`). Preferred: Supabase Dashboard scheduled function, **or** `pg_cron` + `net.http_post` in a new migration `005_schedule_incremental.sql` that reads the function URL and secrets from Vault. If you use pg_cron, guard so local `supabase start` does not fire Mixpanel. Do not commit plaintext service_role keys.
6. Invoke once (with secret) and report JSON: rows, inserted, refresh counts, watermark row.
7. Confirm `GET http://127.0.0.1:4831/api/summary` still returns the five KPIs after refresh (restart 4831 only if you changed Python; you should not have).

Python backfill / prove-day stay. README incremental section: add that production hourly is the Edge Function; the box loop is fallback until cutover.

---

## Verify before you report done

1. Pytest command above still all pass.
2. Deno parse tests match `tests/test_parse.py` on the sample fixture.
3. `curl` without `x-cron-secret` → 401 and **zero** Mixpanel traffic.
4. One live invoke: yesterday inserted 0 or small, today may insert >0; `export_watermarks` job `incremental` status `ok`.
5. `refresh_retention` counts: client_company around 2159, company_activation around 775 (order of magnitude; do not fail if they moved a little after new events). If they drop to 0, you pointed at the wrong source or truncated events. Stop.
6. 4830 health still ok. Incremental loop still running (`pgrep -af incremental_loop`).
7. Grep `web/` (not node_modules) and `metrics/api.py` for mixpanel export URLs: still none.

---

## Report back

- Files you added/changed.
- Whether `db push` applied 004.
- Function URL (no secrets).
- How cron is registered.
- One invoke: inserted counts + refresh counts + watermark.
- Whether you had to raise the function timeout.
- Anything you did not do.

If Mixpanel 401s, stop. If function wall time cannot fit export + refresh, stop and report timings; do not split Mixpanel across overlapping invokes.
