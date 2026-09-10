# Codex brief: company drill insights

Date: 2026-09-05
Owner: Codex (Principal / Staff). Working directory `/root/arena/Tazor/product-metrics`.
Reviewer: Distinguished Engineer after you report done.

Five page-level KPIs stay as they are (including Recon among activated). Do not touch heatmap closed-week SQL. Do not kill 4830. Do not call Mixpanel. Do not git commit. Do not invent event meanings.

Production UI: `web/` at http://127.0.0.1:4832 (proxy 4831). Restart **4831 only** if you change `metrics/api.py`.

---

## What to add

Company drill should answer, without mental math:

1. Where they stalled (step-to-step durations).
2. Which ready path they took (AP / txn / both / neither).
3. Recency of **value** (last Accounting Sync, last Recon Processed).
4. Last week they had value, as weeks since activation, plus Week-8 yes/no if that window is closed.
5. One-line lifetime mix above the by-week table.

Keep the existing path sentence, stats line, by-week table, by-event table, timeline. Add an **insight block** under the company name, above the path sentence. Do not add charts, scores, L4W, or Mixpanel people fields.

---

## API (`GET /api/companies/:id/summary`)

Compute on the server (IST). Do not make the browser subtract timestamps.

Add these fields. Keep every field that exists today (`SUMMARY_KEYS` in `tests/test_api_heatmap.py` grows, it does not shrink).

From timestamps already on `company_profile` (hours, one decimal, **null if either side missing or end < start**):

- `hours_signup_to_upload`
- `hours_upload_to_ready`
- `hours_ready_to_sync`
- `hours_sync_to_recon`

Reuse `_ttv_hours` (or the same helper). `ttv_hours` stays first_sync − signup.

New timestamps from `events` (max `event_time`, company_id match):

- `last_sync_at` (max `Accounting Sync`, null if none)
- `last_recon_at` (max `Recon Processed`, null if none)
- `hours_since_last_sync` (now − last_sync_at, null if no last_sync)
- `hours_since_last_recon` (same for recon)

Path type from existing week-action totals (sum of `by_week`, no new event names):

- `path_type`: `"ap"` if sum(ap_count) > 0 and sum(txn_count) = 0  
  `"txn"` if txn > 0 and ap = 0  
  `"both"` if both > 0  
  `"neither"` if both 0  
  Ready still means Invoice Created (ap) or Transaction Ledger Updated (txn). Do not change that.

Value recency vs activation from `company_week_value` + `company_profile.activation_week` (add `activation_week` to the payload as `YYYY-MM-DD`):

- `last_value_week_start`: max `week_start` where `had_value`, else null
- `last_value_rel_week`: integer `(last_value_week_start - activation_week).days / 7`, null if either missing
- `week8_counted`:  
  `null` if W+8 has not fully elapsed (`activation_week + 63 days > current IST Monday`, same mature rule as the page KPI)  
  `true` if that company has `had_value` on `activation_week + 56 days`  
  `false` if the window is closed and they did not

TDD: extend `SUMMARY_KEYS`. On seed company `c_story` (has Upload, Invoice Created, Accounting Sync, Recon Processed in week 0): `path_type == "ap"`, `last_sync_at` / `last_recon_at` match the seed events, `hours_since_last_sync` is a positive number (do not assert an exact day count), `week8_counted` is not null (April 2026 cohort is mature). On `c_drop` (null recon): `last_recon_at` is null, `hours_sync_to_recon` is null.

Update the one-line contract in `docs/briefs/heatmap-interface.md` for company summary. Do not rewrite activation/value.

---

## UI (`web/components/metrics/retention-explorer.tsx`)

Insight block, sharp, `--radius: 0`, existing tokens. Something like:

- Path: `AP` / `Txn` / `AP + Txn` / `Neither`
- Stall: first missing step in order Upload → Ready → Sync → Recon, or `Complete` if recon exists (or `Activated, no recon` if synced and no recon). Recon missing is not a stall of activation.
- Gaps: `Signup → upload 12.4 h · Upload → ready 2.1 h · Ready → sync 4.6 h · Sync → recon —`
- Value: `Last sync 3 d ago` / `Last recon —` (format hours as `h` under 48 h, else days)
- Retention: `Last value Week 3 · Week 8 yes` / `Week 8 no` / `Week 8 not yet mature`

One mix line above “Actions by week”, from that company’s `by_week` sums, e.g. `Lifetime mix · Upload 40 · Txn 90 · Sync 12 · Recon 0`. No new copy essays.

Skeleton: add bones for the insight block in the company drawer skeleton. Visible UI must not say “Loading…”.

Mirror the same insight block in `ui-design/` only if you can do it without a long prototype rewrite. Next `web/` is the production surface.

---

## Do not

- Change the five KPI cards.
- Treat recon as first value.
- Show negative durations.
- Query Mixpanel.
- Add engagement scores or session counts.

---

## Verify

1. Pytest `tests/test_api_heatmap.py` green, including updated `test_company_summary`.
2. Restart 4831. `curl` one live company (e.g. Foxtrot `0718aa40-6fbd-450d-b1c1-8c8ce3be8f1e`) and show the new fields.
3. Open http://127.0.0.1:4832, click a Week 8 cell, open a company, confirm insight block + mix line. Esc still unmounts the drawer.
4. 4830 still up. `cd web && npm run lint`. Webpack build if Turbopack worker-port fails.

Report new payload keys, pytest count, and the Foxtrot curl snippet. Do not wait.
