# Mixpanel Export → Supabase event store

Date: 2026-09-04
Status: draft for Operator review
Scope: first slice only. Copy events. Do not build the CPO heatmap or scorecard UI in this slice.

## Goal

Pull at least the last 6 months of Mixpanel events for Korefi Prod into our own Postgres (Supabase), then keep that copy a short time behind Mixpanel so dashboards and analysis run on us, not on Mixpanel’s 60-queries-per-hour APIs.

Success looks like:

- One table of events covering 2026-03-04 through today (inclusive), plus ongoing incremental loads.
- Every event has time, event name, Mixpanel `$insert_id`, user ids, `companyId` when Mixpanel sent it, and the rest of the properties.
- Re-running a day does not duplicate rows.
- The dashboard never calls Mixpanel. Mixpanel is only the tracker and the export source.

## Why this slice is first

The CPO explorer (click a retention cell → users → companies → timelines → gaps) needs event rows. Scorecards can be computed from the same rows later. If export is blocked, nothing else should start.

This spec does **not** include:

- Heatmap UI
- Company / user drill-down UI
- Precomputed retention matrices (follows once events exist)
- Composio in production
- Mixpanel Query API (Insights / Funnels / Retention) as a serving path
- People profile export (Engage). Today’s consumer key returns 403. Revisit when Mixpanel role allows it.

## Source

- Product: [app.aiaccountant.com](https://app.aiaccountant.com/)
- Mixpanel project: Korefi Prod, id `3490984`
- Cluster: US (`mixpanel.com` / `data.mixpanel.com`)
- Project timezone: Asia/Kolkata
- About 40 live event names (see FigJam board `product-metrics`)

Not on Enterprise. Data Pipelines is out for now. Path is the Raw Event Export API.

## How Mixpanel export works

Endpoint:

```
GET https://data.mixpanel.com/api/2.0/export
```

Auth: HTTP Basic with a Mixpanel **service account** username and secret. Query param `project_id=3490984` is required.

Response: JSONL. One event per line:

```
{"event":"Sign Up","properties":{"time":...,"$insert_id":"...","distinct_id":"...","companyId":"..."}}
```

Limits (per Mixpanel project):

- 60 export requests per hour
- 3 per second
- `limit` query param cannot exceed 100000 events per request
- 429 if we go over

L6M is about 180 calendar days. One request per day fits the hourly cap if we stay around 1 request every 2 minutes. If a single day is over 100k events, split that day (by event name groups, or by a `where` time window) until each request is under 100k.

Do **not** use Composio for this job. Composio has no raw export tool we can rely on, and production should not depend on an agent toolkit.

Do **not** use the Query API here. Same 60/hour budget, tiny payloads, no user-level rows.

## Permissions (gate)

The connected Mixpanel account is **consumer**. That can run some reports. It cannot list people (Engage 403). Export may also be denied until someone with Mixpanel Admin/Owner creates a service account that can **export events**.

**First engineering task:** request one day (`from_date=to_date=2026-09-03`) with no event filter. If Mixpanel returns 403/401, stop and get a new service account. Do not build loaders on a dead credential.

Need in env (never commit):

- `MIXPANEL_PROJECT_ID=3490984`
- `MIXPANEL_SA_USERNAME`
- `MIXPANEL_SA_SECRET`
- `SUPABASE_DB_URL` (or Supabase URL + service role, used only on the fetcher)

## Destination schema (Supabase Postgres)

Keep this small. One fact table, one watermark table.

### `events`

| Column | Type | Notes |
|---|---|---|
| `insert_id` | text | Mixpanel `$insert_id`. Primary key. |
| `event_name` | text | Mixpanel `event` |
| `event_time` | timestamptz | From `properties.time` (unix). Store UTC. |
| `distinct_id` | text | Mixpanel `distinct_id` |
| `user_id` | text null | `$user_id` or `userId` |
| `uc_uuid` | text null | `ucUuid` |
| `email` | text null | `email` when present |
| `company_id` | text null | `companyId` |
| `company` | text null | `company` name |
| `properties` | jsonb | Full Mixpanel properties object |
| `ingested_at` | timestamptz | When we loaded the row |

Indexes:

- `(event_time)`
- `(company_id, event_time)`
- `(distinct_id, event_time)`
- `(event_name, event_time)`

Primary key `insert_id` is the idempotency key. Mixpanel docs treat `$insert_id` as the de-dupe token. Upsert on conflict do nothing (or update `properties` if we choose replace; default is do nothing so backfills are safe).

If `$insert_id` is missing on a row (should be rare), synthesize `insert_id` as a hash of `event_name + distinct_id + time + stable property subset` so the load still has a key. Log a counter of synthesized ids.

### `export_watermarks`

| Column | Type | Notes |
|---|---|---|
| `job_name` | text pk | `backfill` or `incremental` |
| `last_success_date` | date | Last Mixpanel `to_date` that fully loaded |
| `last_success_at` | timestamptz | |
| `status` | text | `ok` / `failed` |
| `detail` | text null | Last error |

## Jobs

### 1. Prove one day

Export 2026-09-03. Print row count, distinct event names, % of rows with `company_id`, % with `$insert_id`. Load into an empty `events` table. Re-run the same day. Row count must not increase.

### 2. Backfill L6M

Window: `from_date=2026-03-04` through `to_date` = run date.

Walk **one calendar day at a time** (project dates as Mixpanel interprets them). After each successful day, write `export_watermarks`. On 429, sleep and retry with backoff. On a day that returns 100k rows (or Mixpanel truncates), split:

1. Split by event name (the known 40-name list, plus any unknown names from a no-filter probe).
2. If one event is still over 100k that day, split that event into 6-hour `where` windows on `properties["time"]`.

Do not run 60 days in one hour. Target ~20–30 requests/hour so we leave headroom.

### 3. Incremental (“live”)

Every 15–60 minutes (start at **60 minutes**):

- Export yesterday + today (two requests, or one request if Mixpanel accepts a 2-day range **and** the combined volume is safely under 100k).
- Upsert into `events`.
- Late Mixpanel events are why we always re-pull yesterday.

This is “live enough” for a CPO dashboard. It is not streaming.

Optional later: drop the interval to 15 minutes once we know daily volume.

## Timezone

Korefi Prod timezone is Asia/Kolkata. Mixpanel interprets `from_date`/`to_date` as UTC if the project was created after 1 January 2023, otherwise as the project timezone. We have not confirmed Korefi’s created-at. After the one-day prove, compare a known `Sign Up` time in the Mixpanel UI vs `event_time` in Postgres and write the offset in `docs/notes/timezone.md`. Do not guess.

Display in the future UI: Asia/Kolkata. Storage: timestamptz UTC.

## Fetcher shape

A small Python or TypeScript CLI in this repo, runnable locally and later on a cron (GitHub Action or a tiny VM). No web server in this slice.

```
product-metrics/
  docs/specs/          this file
  supabase/migrations/ events + watermarks
  fetcher/
    export_day.py      one day → JSONL
    load_day.py        JSONL → upsert
    backfill.py        date loop
    incremental.py     yesterday + today
  .env.example
```

Use Mixpanel HTTP directly (`data.mixpanel.com`). Gzip `Accept-Encoding: gzip`.

Log: day, request count, rows, 429s, synthesized insert ids. No event payloads in logs (PII: email).

## What “maximum data” means here

- All event names Mixpanel returns for that day, not a hand-picked subset.
- Full `properties` JSON, not a column per property (properties will keep changing).
- Promoted columns only for join keys we already know we query: user, company, time, name, insert_id.

That is enough for L6M analysis and for the later explorer. It is not a clone of Mixpanel’s identity graph.

## Failure and safety

- 401/403: fail the job, do not loop.
- 429: wait, retry, cap retries per day.
- Partial day: do not advance the watermark until that day upserts cleanly.
- Secrets only in env / Supabase vault. Never in git.
- Fetcher uses the Supabase service role or a direct Postgres URL. The future dashboard uses a read-only role.

## Test plan (this slice)

- Unit: parse one JSONL fixture, map to row, missing `$insert_id` gets a synthesized key.
- Integration (needs credentials): one-day export, load, reload, count stable.
- Backfill dry-run: three consecutive days, watermark moves, no dupes.

## Next specs (not this one)

After events exist and L6M is loaded:

1. Feature map (event name → AP / Txn / Recon / Sync / …)
2. Retention cell tables + heatmap
3. Company / user explorer
4. Scorecard metrics from the same `events` table

## Open items that do not block the spec

- Exact Mixpanel plan name (Free vs Growth). Export API exists on both; Pipelines does not. We already chose Export.
- Supabase project URL. Operator creates (or points us at) a project; schema lives in `supabase/migrations`.
- Cron host. Local + documented schedule is enough until events load.
