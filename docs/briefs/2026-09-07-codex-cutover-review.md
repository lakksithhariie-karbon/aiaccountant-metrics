# Codex review: Free aia-all → Pro "ai accountant (p&e)" warehouse cutover

Date: 2026-09-07
Owner: Codex (Principal / Staff). **Review only. Do not implement. Do not migrate. Do not git commit. Do not kill 4830. Do not call Mixpanel. Do not stop `scripts/incremental_loop.sh`.**
Reviewer: Distinguished Engineer. Operator decides.

Working directory (hard): `/root/arena/Tazor/product-metrics`

You are the coworker. Stress-test this plan. If it is wrong, say so with a better sequence. If it is right, say what you would not change.

---

## Context

Internal Product Metrics for Korefi / AI Accountant. Mixpanel is the tracker only (Korefi Prod `3490984`, US, timezone Asia/Kolkata). Raw events live in **our Postgres**. Dashboards never call Mixpanel.

**Source (today):** Supabase project `aia-all` (`vphqalgyudaayzswtkac`), Free org `lakksithhariie`, region `ap-southeast-2`. ~350k rows in `public.events`, ~210 MB after we slimmed Mixpanel `properties` to `{companyName}` and `VACUUM FULL`. That org hit Free quota (egress 11 GB / 5 GB, DB was 0.575 / 0.5 GB).

**Target:** new Supabase project **ai accountant (p&e)** in Pro org **AI Accountant**. Empty. SMALL 2 GB. Operator just created it. Different org, so no branching / no clone button.

Live ingest: Edge Function `sync-incremental` (hourly pg_cron) **and** box `scripts/incremental_loop.sh`. Dual-write. Python Mixpanel export does not count as Supabase egress. Edge Mixpanel fetch likely does.

Ports: 4830 old API (leave up). 4831 current `metrics.api`. 4832 Next. Vercel production reads Supabase directly.

Signed metric contract is unchanged. Do not reopen activation / value / action / staff / IST weeks. Specs: `docs/briefs/heatmap-interface.md`, `supabase/migrations/004_sync_rpcs.sql`.

---

## Plan to validate (DE)

1. Mixpanel does **not** move. We copy **our warehouse**, then rebuild derived tables.
2. Copy **only** `public.events` (plus one watermark row). Do **not** copy `client_company`, `company_activation`, `company_week_*`, `retention_cells`, `company_profile`. Those are `refresh_retention()` caches.
3. Do **not** re-export L6M from Mixpanel as the migration vehicle (slow, 120s gaps, synthesized `insert_id` risk). Mixpanel is a **count check** after copy, not the pipe.
4. New project gets a **cleaner ingest schema**, not a dump of the old one:
   - Drop `properties jsonb`
   - Drop duplicate `company` (UUID; same as `company_id`)
   - Add `company_name text` (today: `properties->>'companyName'`)
   - Keep: `insert_id`, `event_name`, `event_time`, `distinct_id`, `user_id`, `uc_uuid`, `email`, `company_id`, `ingested_at`
   - Same four secondary indexes: `event_time`, `(company_id, event_time)`, `(distinct_id, event_time)`, `(event_name, event_time)`
5. `refresh_retention` / upsert RPC / Next+Python APIs that read `properties->>'companyName'` must read `company_name` instead. Metric meaning unchanged.
6. Role `product_metrics_fetcher` on the new project, DML only, no `anon` grants.
7. Cutover: freeze FREE writes → DDL on PRO → COPY transform → `refresh_retention` → prove counts (events n, activated, client_company, week-8 **11/53 on 2026-06-29**, DAU/WAU/MAU same IST window) → point 4831 / Vercel / Edge secrets → one incremental yesterday+today → keep FREE read-only 7 days.

Copy mechanism: this box, two connection strings, `INSERT...SELECT` or `COPY`. Not `db dump` of the whole FREE project (auth/vault/cron/toast).

---

## What we need from you

Read the live migrations and the APIs that touch `properties` / `company`:

- `supabase/migrations/001_events.sql` through `004_sync_rpcs.sql`
- `metrics/api.py`, `web/lib/metrics-server.ts`
- `fetcher/parse.py`, `fetcher/load.py` (warehouse_properties already slims on write)
- `supabase/functions/sync-incremental/parse.ts`

Then answer in this order:

### 1. Copy vs Mixpanel re-export
Agree or disagree that the Free `events` table is the right source for the move. Name the failure mode if we re-export 6 months instead.

### 2. Schema
Is dropping `properties` and `company` safe given current readers? List every file that must change. If you would keep slim jsonb instead, say why.

### 3. Derived tables
Agree or disagree that we rebuild instead of copy. Any derived table that is **not** a pure function of `events` today?

### 4. Cutover holes
What the sequence misses: watermark races, dual-write, Edge cron on the old project, Vercel env, `product_metrics_fetcher` vs `postgres` vs pooler username (`user.projectref` on pooler), RLS vs our table grants, statement timeouts on 350k COPY, week-8 mature rule during the freeze.

### 5. Egress / Pro
Will the copy itself blow egress on the **Free** project (SELECT 350k rows out)? How to copy without another quota incident (single `COPY TO STDOUT`, no `SELECT *` from the dashboard, no Edge in the path).

### 6. Verdict
One of: **ship as written** / **ship with these deltas** (bullet list) / **do not ship until X**. No implementation. No migrations applied. No git commit.

Live sanity on FREE (after slim): `events` ~350k, DB ~210 MB, activated **778**, client_company **2165**, week-8 **11/53 (20.8%)** cohort **2026-06-29**. If your read of the code disagrees with the plan, the code wins. Report that.
