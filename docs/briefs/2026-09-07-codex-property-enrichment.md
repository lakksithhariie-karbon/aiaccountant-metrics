# Codex brief: property enrichment on live Pro (do not break ingest)

Date: 2026-09-07
Owner: Codex. You implement and run this. Distinguished Engineer reviews after
each gate. Operator go/no-go on Overview splits.
Working directory (hard): `/root/arena/Tazor/product-metrics`

Read `.env`. Do not print it. Do not paste secrets in chat, logs, or git.
Do not git commit / push unless Operator asks.

Locked by Operator + DE + your review. Do not reopen the allowlist or the
signed metric contract.

Spec: `docs/specs/2026-09-07-event-property-dictionary.md` (`event_properties.v1`).

---

## Non-negotiable (breakage)

Pro is production. Hourly cron is the writer. Vercel + 4831 read Pro.

- Do not kill **4830**. Do not bind **3000**. Do not restart 4831/4832 unless
  a flag/API you added needs it, and then verify `/api/summary` still matches
  pre-change client/activated/week-8.
- Do not `supabase link` away from Pro `hdgbmcerogqfocyxdnpw`.
- Do not touch Free `vphqalgyudaayzswtkac`.
- Do not DELETE/TRUNCATE `events` or derived tables.
- Do not UPDATE `insert_id`, `event_name`, `event_time`, `distinct_id`,
  `user_id`, `uc_uuid`, `email`, `company_id`, `company`.
- Do not change activation / ready / week-8 SQL meaning.
- Do not restore full Mixpanel blobs. Allowlist only.
- Do not expose new tables to `anon` / `authenticated`.
- Do not leave Pro cron unscheduled. If you pause it, restore it in a
  `finally` even when the backfill fails.
- Do not point Vercel at another DB.
- If identity on a Mixpanel re-export disagrees with the warehouse row
  (`event_name`, `event_time`, `distinct_id`, `company_id`), **record and
  stop**. Do not overwrite.

---

## Creds

Already in gitignored `/root/arena/Tazor/product-metrics/.env`:

- `MIXPANEL_PROJECT_ID`
- `MIXPANEL_SA_USERNAME`
- `MIXPANEL_SA_SECRET`
- `SUPABASE_DB_URL` (Pro, role `product_metrics_fetcher`, host
  `db.hdgbmcerogqfocyxdnpw.supabase.co`)
- `MIXPANEL_COMPANY_DATA_GROUP_ID` (not a secret; optional name enrichment)

Dashboards still never call Mixpanel. Only fetcher / backfill / Engage jobs.

---

## Order (do not skip)

1. Dictionary is already locked. Add a storage budget check (script):
   `pg_database_size`, `pg_total_relation_size('public.events')` before
   work. Abort if database is above **1.5 GB** or events would grow more
   than **80 MB**. SMALL plan is 2 GB.
2. Tests on scratch Postgres first. Then change ingest paths. Then deploy
   Edge Function to **Pro**. Then backfill. Then flags. Then optional
   Engage. Overview UI last, only after coverage.
3. User profiles: follow-on, after flags, only for people-drawer
   `userRole`. Do not apply current role to old cohorts.
4. Mixpanel company profiles: optional name backfill. Never the source of
   `client_company`, activation, staff filter, or retention denominators.

---

## Ingest contract

Today Python `fetcher/load.py`, Edge `parse.ts`, and
`upsert_mixpanel_events` all slim to `companyName` and
`ON CONFLICT DO NOTHING`. That will never enrich existing rows.

Required:

- One shared allowlist + merge helper used by Python and SQL (Edge must
  send the same keys; SQL is the safety net).
- `warehouse_properties` / SQL strip keep v1 keys only, after
  normalization in the spec.
- Insert new `insert_id`s as today.
- On conflict: **update `properties` only**.
- Merge: `old || new_allowlisted`, but
  `companyName = COALESCE(nullif(new,''), old.companyName)`.
  Never replace a name with `{}`.
- Skip the row (no property write) if identity disagrees. Count them.
  Abort the day if identity mismatches exceed **10**.
- Skip the UPDATE when merged jsonb is identical (no WAL storm).
- Same allowlist on RPC and incremental. Deploy Function **before**
  resuming cron.

TDD: scratch tests for merge, identity abort, allowlist drop of
`fileName`/`gstin`/`sync_items`, Failed upload not setting flags.

---

## Backfill window (Mixpanel 60/hour)

Pro cron `sync-incremental-hourly` is `5 * * * *` UTC.

1. Snapshot prove metrics on Pro (events count, IST day checksum,
   client_company, activated, week-8 cell). Write them down.
2. Unschedule **only** that job. Leave jira/other jobs alone (those are
   not on Pro; Pro should only have this ingest job).
3. Sequential IST-day Mixpanel export `2026-03-04` → yesterday, gap
   matching existing backfill (~120s). Job name
   `property_backfill` in `export_watermarks`. **Do not rewind**
   `incremental` `last_success_date`.
4. After last day: one catch-up `incremental` (yesterday+today).
5. Restore cron via the same Vault schedule as `009` (`5 * * * *`,
   Vault URL, 150s). Verify `cron.job` has `sync-incremental-hourly`
   and the command contains no Free hostname.
6. Compare snapshot: **event count must not drop**. New insert_ids from
   Mixpanel are ok. client_company / activated / week-8 must match
   unless you can prove the delta is new companies from catch-up, not
   a rewrite.

If Mixpanel 429s, wait and continue. Do not parallelize exporters.

---

## Flags

After properties exist, extend `refresh_retention` (or a new function
called from it) to fill `company_week_product` with the flags in the
spec. Client companies only, same staff rule as today.

SQL views for QA. Materialize for API. Do not change
`company_week_action` signed counts.

Do not ship Overview splits until you report Upload `type` coverage
for the latest complete IST week.

---

## Optional Engage (after flags)

- `user_profiles`: 2.3k rows from Engage. Grants like warehouse.
  DISABLE RLS. Revoke anon/authenticated. `userRole` is current-state
  only.
- Company group: `data_group_id` from env. Audit table
  `company_id, company_name, last_seen_at` at most. Optional name
  fill where `company_profile.company_name` is null. Do not upsert
  Mixpanel orphans into `client_company`.

---

## Report back (gates)

Stop and report after:

1. Tests green + Function deployed to Pro + cron still running (ingest
   live on allowlist, backfill not started).
2. Cron paused, backfill started (include PID and first-day stats).
3. Backfill done, cron restored, prove snapshot vs after.
4. Flags rebuilt + coverage numbers.
5. Optional Engage, if you did it.

DE reviews. Do not open Overview splits until Operator says yes.
