# Droid brief: explorer hardening + granular drill

Date: 2026-09-04
Owner: Factory Droid (Staff / Principal), implementation only
Reviewer: Distinguished Engineer after you report done
Working directory (hard): `/root/arena/Tazor/product-metrics`
App: one process, `127.0.0.1:4830` (`PORT=4830`)

You are the orchestrator. Spawn workers. Do not implement the whole slice in one session. Do not invent event meaning. Do not call Mixpanel or Composio. Do not change `fetcher/`. Do not stop `scripts/incremental_loop.sh`. Do not git commit unless the Operator asks. Do not reset DB passwords. Do not create a new Supabase project.

If CREATE TABLE is denied on aia-all, stop. Last time postgres applied DDL via `npx supabase db push --linked`. Use that path again for new migrations. `SUPABASE_DB_URL` is role `product_metrics_fetcher` (DML only). `metrics/refresh.py` must skip CREATE when tables exist (keep that). GRANT DML+TRUNCATE on any new tables to `product_metrics_fetcher` inside the migration, wrapped in `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'product_metrics_fetcher')`.

After DDL, restart the existing API on 4830 (kill the current `python -m metrics.api` then start it). Keep `_db()` connection reuse + `autocommit = True`. Do not go back to `with psycopg.connect() as conn` per request (that was a 1.6s TLS handshake to Sydney each click).

---

## Read first, in this order

1. This file
2. `docs/specs/2026-09-04-feature-map.md`
3. FigJam Feature map: https://www.figma.com/board/pNOMEJi1e5deRYQ5n6VnZg/product-metrics?node-id=27-649
4. `docs/briefs/heatmap-interface.md` (update it when the API shape changes)
5. `metrics/refresh.py`, `metrics/api.py`, `web/app.js`, `web/index.html`, `web/styles.css`
6. `tests/test_metrics_refresh.py`, `tests/test_api_heatmap.py`

Live warehouse: `public.events` on aia-all (~346k rows). Connect with `SUPABASE_DB_URL` from `.env`. Tests: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics`.

---

## Locked metric contract (do not change)

Timezone: Asia/Kolkata. Week = Monday via `date_trunc('week', event_time AT TIME ZONE 'Asia/Kolkata')`.

1. **Activation (company)** = first `Accounting Sync` with non-null `company_id`.
2. **Value** (keeps a company in week-8) = `Accounting Sync` OR `Recon Processed` only. Dashboard Viewed, Login, Upload, etc. are NOT value.
3. **Week-8 retained** = activated in week W AND a value event in calendar week W+8 (not 56 days from `activated_at`).
4. Mixpanel custom event `Created Bill or marked txn a/c ready` is not in Raw Export. Ready = `Invoice Created` OR `Transaction Ledger Updated`.
5. Join on `company_id`. Null company_id never enters company metrics.
6. `company` column on events **is the UUID**. Display name = `properties->>'companyName'`.

### Staff filter (already in `metrics/api.py`, must also apply in refresh)

Internal email domains: `karboncard.com`, `korefi.ai` (case-insensitive, `Name <user@domain>` form, subdomains count). Use the existing `is_internal_email()`.

A **client company** has at least one event with a non-null email that is **not** internal.

A **staff-only company** has one or more emails, and every non-null email is internal.

Rules:

- Staff-only companies are **out of `company_activation`, `company_week_value`, `retention_cells`, and the explorer**. Heatmap `retained_count` must equal the number of distinct companies in that cell’s people payload.
- Client companies stay even if staff also fired events on them. Staff emails still do not appear in the people list.
- Companies with **no email on any row**: keep them (do not treat unknown as staff).
- Do not drop events from `public.events`. Filter only derived tables + API responses.

### Action vs value vs chrome (new, for the deeper drill)

**Value** (retention): `Accounting Sync`, `Recon Processed`.

**Action** (activity / frequency). These are product work, not sitting on a page:

- `Upload`
- `Mapping Completed`, `Saved Template Loaded`
- `Invoice Created`, `Invoice Bulk Edited`, `Download-Inv`, `Preview`
- `Transaction Ledger Updated`, `Transaction Status`, `Transaction Type Updated`, `Transaction Configuration Edited`, `Vendor Mismatch Resolved`
- `Accounting Sync`, `Recon Processed`
- `Entity Created`, `Delete`, `Download`, `Export`

**Not actions** (do not count in activity/frequency): `Sign Up`, `Login`, `logout`, `Dashboard Viewed`, `Widget Clicked`, all `Phone *`, `Duplicate Phone Attempt`, `Company Created`, `Company Updated`, `Company Switched`, `Product Subscription`, all `Billing Intent *`.

**Signed up** for a company = `min(event_time)` of `Company Created` for that `company_id`. If none, `min(event_time)` of any event on that `company_id`. Do not use `Sign Up` as the company clock (`Sign Up` is a user event and often predates the company).

**Signed up** for a user = `min(event_time)` of `Sign Up` for that `distinct_id` / email. If none, first event we have for that user.

---

## Why this slice exists

Current explorer bugs the Operator already felt:

1. Heatmap still counted staff-only companies; people list hid them. Numbers disagreed.
2. Cell click ran four sequential queries to Sydney (~240ms RTT each) after we fixed the TLS reconnect. Still ~1s.
3. Timeline painted up to 5000 `<li>` nodes. Slow and unreadable.
4. Grid is a first-pass table: no selected cell, ISO dates only, no activity grain.

The Operator also wants the drill to answer product questions, not dump UUIDs:

- When did this company/user first exist?
- How many **actions** since then (upload / txn / sync / recon / …), not page views?
- How **often** (active weeks, actions per active week, last action)?
- In the **selected relative week**, what did they actually do?

That is still this explorer, not the scorecard. Do not build scorecard tiles (activation rate, median TTV, WAC, adopted, expansion) in this slice.

---

## Data layer (Worker A owns)

New migration `supabase/migrations/003_explorer.sql` plus refresh changes.

Keep existing three tables, but **rebuild them from client companies only**.

Add (names may vary; columns must exist):

```
client_company (
  company_id text primary key
)

company_profile (
  company_id text primary key,
  company_name text,                 -- latest non-null properties.companyName
  signed_up_at timestamptz not null, -- Company Created else first event
  activated_at timestamptz not null,
  activation_week date not null,
  first_upload_at timestamptz,
  first_ready_at timestamptz,        -- Invoice Created OR Transaction Ledger Updated
  first_sync_at timestamptz,         -- same as activated_at if activation is first sync
  first_recon_at timestamptz,
  last_action_at timestamptz,
  action_count int not null,         -- lifetime actions
  active_weeks int not null,         -- distinct IST weeks with >=1 action
  path_had_upload boolean not null,
  path_had_ready boolean not null,
  path_had_sync boolean not null,
  path_had_recon boolean not null
)

company_week_action (
  company_id text not null,
  week_start date not null,
  action_count int not null,
  upload_count int not null,
  txn_count int not null,            -- Ledger/Status/Type/Config/Vendor Mismatch
  ap_count int not null,             -- Invoice Created/Bulk/Download-Inv/Preview
  sync_count int not null,
  recon_count int not null,
  other_action_count int not null,   -- mapping, entity, delete, download, export
  primary key (company_id, week_start)
)
```

`python -m metrics refresh` rebuilds **all** of these plus the three retention tables in one transaction. Idempotent. Never writes `events`. Print row counts including `client_company` and `company_profile`.

TDD on `TEST_DATABASE_URL` (extend `tests/test_metrics_refresh.py`):

- Staff-only company (every email `@karboncard.com`) is absent from `company_activation` and `client_company`.
- Client + staff on the same company: company stays; activation week still first Accounting Sync.
- Recon in W+8 still retains; Dashboard-only W+8 still does not.
- `company_week_action.action_count` ignores Login and Dashboard Viewed.
- Refresh is idempotent. Events table row count unchanged.

File ownership: `supabase/migrations/003_explorer.sql`, `metrics/refresh.py`, `tests/test_metrics_refresh.py`. Do not edit `web/`.

After tests pass, `npx supabase db push --linked --yes` (or stop if denied), then `python -m metrics refresh` on aia-all. Report: client companies, activation companies, cells, and that heatmap `sum` of a week-8 cell equals cell-API distinct companies.

---

## API (Worker B, after Worker A tables exist)

Keep `_db()` reuse. Health stays `{"ok": true}` without a new connect if possible.

**Cell must be one database round trip** after the members list (or one CTE total). Forbidden: per-company loops, four sequential `execute`s to `events`. Read `company_profile` + `company_week_action` + people from `events` in at most two statements, preferably one JSON aggregate. Target: warm cell < 400ms on this host.

People query still filters `is_internal_email` (or the SQL equivalent). Only client companies will be in members once refresh is fixed.

### `GET /api/heatmap`

Unchanged shape: `{cohort_week, rel_week, cohort_size, retained_count, rate}`. Counts now exclude staff-only companies.

### `GET /api/heatmap/cell?cohort_week=&rel_week=`

Return **users** with nested **companies**, plus a cell summary:

```
{
  "cohort_week": "YYYY-MM-DD",
  "rel_week": 8,
  "people_count": N,
  "company_count": M,          -- MUST equal heatmap retained_count for this cell
  "median_actions_that_week": Q,
  "share_with_upload": 0.0,    -- of companies in this cell
  "share_with_sync": 0.0,
  "share_with_recon": 0.0,
  "users": [
    {
      "email": "ca@client.com",
      "distinct_id": "...",
      "user_id": "...",
      "signed_up_at": "...",
      "last_action_at": "...",
      "lifetime_actions": 12,
      "active_weeks": 4,
      "actions_per_active_week": 3.0,
      "actions_that_week": 5,
      "companies": [
        {
          "company_id": "...",
          "company_name": "CONCORDE LOGISITCS",
          "signed_up_at": "...",
          "activated_at": "...",
          "last_action_at": "...",
          "lifetime_actions": 80,
          "active_weeks": 6,
          "actions_per_active_week": 13.3,
          "actions_that_week": 4,
          "upload_that_week": 1,
          "txn_that_week": 2,
          "sync_that_week": 1,
          "recon_that_week": 0,
          "path_had_upload": true,
          "path_had_ready": true,
          "path_had_sync": true,
          "path_had_recon": false,
          "ttv_hours": 36.5,          -- first_sync - signed_up_at, null if missing
          "value_events": ["Accounting Sync"]
        }
      ]
    }
  ]
}
```

`actions_that_week` = `company_week_action.action_count` for `activation_week + rel_week * 7`. Missing week → 0.

User-level action stats: sum/max across that user’s companies in the cell, computed in SQL or in Python from the same rows. Do not scan all events per user in a loop.

Old flat `{company_id, activated_at, value_events}` is dead. Update `tests/test_api_heatmap.py`.

### `GET /api/companies/:id/summary`

```
{
  "company_id": "...",
  "company_name": "...",
  "signed_up_at": "...",
  "activated_at": "...",
  "first_upload_at": "...",
  "first_ready_at": "...",
  "first_sync_at": "...",
  "first_recon_at": "...",
  "last_action_at": "...",
  "lifetime_actions": 80,
  "active_weeks": 6,
  "actions_per_active_week": 13.3,
  "ttv_hours": 36.5,
  "path_had_upload": true,
  "path_had_ready": true,
  "path_had_sync": true,
  "path_had_recon": false,
  "by_week": [ { "week_start": "YYYY-MM-DD", "action_count": 4, "upload_count": 1, "txn_count": 2, "ap_count": 0, "sync_count": 1, "recon_count": 0 } ],
  "by_event": [ { "event_name": "Upload", "count": 12 } ]   -- actions only, lifetime, desc
}
```

`by_event` can be a single grouped query on `events` for that one company (one round trip). Cap 40 names.

### `GET /api/companies/:id/timeline?limit=100&offset=0`

Default **limit 100**, max 500. Oldest or newest: **newest first** for the page (Operator is looking at recent work). Include `event_name`, `event_time` only. No email. Return `{ "total": N, "limit": 100, "offset": 0, "events": [...] }`.

Tests: default page length 100; `limit=5000` rejected or clamped; email absent; Login/Dashboard may appear in timeline (it is a log) but not in `by_event` action totals.

File ownership: `metrics/api.py`, `tests/test_api_heatmap.py`. Do not fight Worker C on `web/` except to keep JSON keys stable.

---

## UI (Worker C)

`web/` only. System fonts. No Inter, no indigo/violet gradients, no pill spam, no fake stat row of invented numbers. Hierarchy from type size and space. Selected heatmap cell: 2px outline, not a glow.

Heatmap:

- Cohort label: `3 Mar 2026` plus ISO in `title`.
- Clicked cell stays selected until another click.
- Cell button shows `retained / n` and `%` as now.
- After load, a line under the table: `Week-8 example: {last week-8 cohort} kept {k} of {n} client companies.` Only if data exists. Use real cells, do not invent.

People panel:

- Title: `{M} companies · {N} people` and those M, N come from the cell JSON (`company_count`, `people_count`).
- One-line cell insight from the summary fields: median actions that week; % with upload / sync / recon. Real numbers from the API.
- Each **user**: email, signed_up_at (date), lifetime_actions, active_weeks, actions_per_active_week, actions_that_week.
- Nested **company**: **name** (UUID muted), signed_up_at, activated_at, TTV if present, last_action_at, lifetime_actions, active_weeks, actions_that_week split upload/txn/sync/recon, path ticks (upload / ready / sync / recon).
- Sort users by `actions_that_week` desc, then email.
- Filter box: substring match on email or company name (client-side is fine).

Company panel (replaces the 5000-row list as the default):

- Load `/summary` first. Show the path as dates: signed up → first upload → first ready → first sync → first recon (em dash if missing). Show lifetime_actions, active_weeks, actions_per_active_week, last_action_at.
- Small table of `by_week` (week_start, action_count, upload, txn, sync, recon).
- Small table of `by_event` (name, count).
- Timeline: newest 100 actions. Button “older” uses `offset`. Never render more than 200 rows in the DOM at once (replace, do not append without bound).

Keep one process on 4830 serving `web/` + API.

---

## Worker D (validator, last)

1. `TEST_DATABASE_URL=... pytest -q` green.
2. `python -m metrics refresh` already run on aia-all; print counts.
3. Restart API on 4830. `curl -sf http://127.0.0.1:4830/health` → `{"ok":true}`.
4. Pick a week-8 cell. `company_count` from `/api/heatmap/cell` **equals** `retained_count` from `/api/heatmap` for that cohort/rel_week.
5. Response JSON has no `@karboncard.com` or `@korefi.ai`.
6. Time `/api/heatmap` and one cell GET; report seconds. Cell should be well under the old ~4s; aim < 0.4s warm.
7. Open the UI, click a non-zero week-8 cell, confirm people show signup + action stats, click a company, confirm summary path and a 100-row page, not 2800 `<li>`.
8. Grep new code for `mixpanel` / `composio`; empty.

---

## Deviation tripwires (stop and report; do not “fix around”)

- Counting Login or Dashboard Viewed as actions or as value.
- Using Mixpanel `company` as a display name.
- Querying Mixpanel or Composio.
- Re-opening a DB connection per HTTP request.
- Painting thousands of timeline nodes.
- Changing activation to something other than first Accounting Sync.
- Filtering staff by dropping **events** from `public.events`.
- Scorecard tiles, auth, new ports.

---

## Done when

- Heatmap and people list agree on company counts for every cell you spot-check (at least one week-8 and one week-0).
- Staff emails gone from people JSON.
- Cell click feels like heatmap click (same order of magnitude, not seconds).
- Company drill shows signup, action counts, frequency, that-week mix, path dates, paged timeline.
- Tests green. README Explorer section updated (refresh, start, port 4830, staff filter, action definition in one line).
- You report: test counts, refresh counts, timed heatmap/cell/summary, 4830 URL.

Scorecard is **not** this slice. Stop when the explorer is something a CPO can trust.
