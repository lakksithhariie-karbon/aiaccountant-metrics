# Mixpanel Export → Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy Korefi Prod Mixpanel events into Postgres and keep them current via a CLI that talks only to the Raw Event Export API.

**Architecture:** A Python fetcher calls `https://data.mixpanel.com/api/2.0/export` one calendar day at a time, maps JSONL lines into rows, and upserts on `insert_id`. A watermark table records the last fully loaded day. No Composio. No Query API. No dashboard in this slice.

**Tech Stack:** Python 3.11+, pytest, httpx, psycopg, python-dotenv, Supabase Postgres (SQL migrations).

**Spec:** `docs/specs/2026-09-04-mixpanel-export-supabase-design.md`

## Global Constraints

- Mixpanel project id `3490984`, US cluster `data.mixpanel.com`
- Export window for backfill starts `2026-03-04`
- 60 export requests per hour, 3 per second, max 100000 events per request
- 401/403 fail the job and do not retry-loop
- 429 sleep and retry with backoff
- Never log event payloads (email is PII)
- Never commit secrets
- Upsert on Mixpanel `$insert_id`; if missing, synthesize a stable hash
- Do not build heatmap, explorer, or scorecard UI in this plan

## File map

- Create: `pyproject.toml`
- Create: `.env.example`
- Create: `supabase/migrations/001_events.sql`
- Create: `fetcher/__init__.py`
- Create: `fetcher/parse.py` — JSONL line → `EventRow`
- Create: `fetcher/export_client.py` — HTTP export, 429 backoff, 401/403 fail
- Create: `fetcher/load.py` — upsert rows, watermarks
- Create: `fetcher/known_events.py` — 40 event names for split-by-event
- Create: `fetcher/cli.py` — `prove-day`, `backfill`, `incremental`
- Create: `tests/test_parse.py`
- Create: `tests/test_export_client.py`
- Create: `tests/test_load.py`
- Create: `tests/fixtures/sample_day.jsonl`
- Create: `README.md`

---

### Task 1: Parse Mixpanel JSONL into EventRow

**Files:**
- Create: `fetcher/parse.py`
- Create: `tests/test_parse.py`
- Create: `tests/fixtures/sample_day.jsonl`
- Create: `pyproject.toml`

**Interfaces:**
- Produces: `EventRow` dataclass; `parse_jsonl_line(line: str) -> EventRow`; `parse_jsonl(text: str) -> tuple[list[EventRow], ParseStats]`

- [ ] **Step 1: Write failing tests** in `tests/test_parse.py` for: map `$insert_id`, `event`, unix `time`, `distinct_id`, `$user_id`/`userId`, `ucUuid`, `email`, `companyId`, `company`; keep full `properties`; synthesize `insert_id` when `$insert_id` missing; skip blank lines.

- [ ] **Step 2: Run** `pytest tests/test_parse.py -v` — expect FAIL (module missing).

- [ ] **Step 3: Implement** `fetcher/parse.py` with the dataclass and parsers.

- [ ] **Step 4: Run** `pytest tests/test_parse.py -v` — expect PASS.

---

### Task 2: Export HTTP client

**Files:**
- Create: `fetcher/export_client.py`
- Create: `fetcher/known_events.py`
- Create: `tests/test_export_client.py`

**Interfaces:**
- Consumes: none from parse
- Produces: `ExportClient.export_day(day: date, event_names: list[str] | None = None) -> str` (JSONL text); raises `ExportAuthError` on 401/403; retries 429 then raises `ExportRateLimitError`; `needs_split(jsonl: str) -> bool` when line count >= 100000

- [ ] **Step 1: Write failing tests** using httpx mock transport: 200 returns JSONL; 401 raises `ExportAuthError` and does not retry; 429 then 200 retries once; 100000 lines → `needs_split` True.

- [ ] **Step 2: Run** `pytest tests/test_export_client.py -v` — expect FAIL.

- [ ] **Step 3: Implement** GET `https://data.mixpanel.com/api/2.0/export` with Basic auth, `project_id`, `from_date`, `to_date`, optional `event` JSON array, `Accept-Encoding: gzip`, `time_in_ms=true`.

- [ ] **Step 4: Run** `pytest tests/test_export_client.py -v` — expect PASS.

---

### Task 3: Schema + loader

**Files:**
- Create: `supabase/migrations/001_events.sql`
- Create: `fetcher/load.py`
- Create: `tests/test_load.py`

**Interfaces:**
- Consumes: `EventRow` from parse
- Produces: `apply_migration(conn)`; `upsert_events(conn, rows: list[EventRow]) -> int` (inserted count, conflict do nothing); `set_watermark(conn, job_name: str, last_success_date, status, detail=None)`

- [ ] **Step 1: Write failing tests** against a local Postgres if `TEST_DATABASE_URL` is set, otherwise skip DB tests with a clear skip. Always unit-test SQL conflict behavior with a documented fixture when DB is present: load twice, count unchanged; missing insert_id still unique; watermark updates.

- [ ] **Step 2: Write** `001_events.sql` exactly as the spec (`events` + `export_watermarks` + indexes).

- [ ] **Step 3: Implement** `fetcher/load.py` with `ON CONFLICT (insert_id) DO NOTHING`.

- [ ] **Step 4: Run** `pytest tests/test_load.py -v`.

---

### Task 4: CLI jobs

**Files:**
- Create: `fetcher/cli.py`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Consumes: ExportClient, parse_jsonl, upsert_events, set_watermark
- Produces: CLI `python -m fetcher prove-day --date 2026-09-03`; `python -m fetcher backfill --from 2026-03-04 --to YYYY-MM-DD`; `python -m fetcher incremental`

Behavior:
- `prove-day`: export, print counts (rows, event names, pct with company_id, pct with real insert_id, synthesized count), load, export+load again, print second count (must match).
- `backfill`: one day at a time, ~2 minutes between requests, on `needs_split` split by `KNOWN_EVENTS` then 6-hour windows; do not advance watermark on failure; 401/403 abort.
- `incremental`: yesterday and today; watermark job_name `incremental`.
- Logs: day, request count, rows, 429s, synthesized ids. Never log JSONL.

- [ ] **Step 1: Implement CLI** reading env `MIXPANEL_PROJECT_ID`, `MIXPANEL_SA_USERNAME`, `MIXPANEL_SA_SECRET`, `SUPABASE_DB_URL`.

- [ ] **Step 2: `.env.example` and README** with prove-day as the first command.

- [ ] **Step 3: Run** `pytest -v` full suite.

---

## Spec coverage

| Spec item | Task |
|---|---|
| One-day prove | Task 4 |
| L6M backfill day loop + split | Task 4 |
| Incremental yesterday+today | Task 4 |
| Schema + upsert | Task 3 |
| Parse + synthesized insert_id | Task 1 |
| Direct Export API, gzip | Task 2 |
| 401/403 no loop, 429 retry | Task 2 |
| No Composio / Query API | all |
| PII not logged | Task 4 |
| Timezone note after prove | README, not automated |

No heatmap/explorer in this plan.
