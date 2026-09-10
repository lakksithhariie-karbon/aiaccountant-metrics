# Codex brief: Overview charts + drill

Date: 2026-09-05
Owner: Codex (Principal / Staff). You implement backend and frontend.
Reviewer: Distinguished Engineer (validates, verifies, fixes only if you miss). Operator decides product.
Working directory (hard): `/root/arena/Tazor/product-metrics`
Do not work in sibling dirs. Do not git commit. Do not kill **4830**. Do not call Mixpanel. Do not stop `scripts/incremental_loop.sh`.

Visual refs (Axis HR dashboards, Finances + Demographics): chart *types* only. Do not copy lime pills, round cards, drop shadows, or fake HR dimensions. Stay on the existing Product Metrics shell (`MetricsChrome`, Montserrat, `--chart-1`…`--chart-5`, existing `--radius`).

---

## What we are building

Overview is no longer four KPI cards and a caption. Keep the four KPI cards. Under them, a two-row Axis-style chart grid with **click-to-drill** into the same people/company drawer language as Retention.

The four KPI meanings stay signed. Live sanity (IST 2026-09-05): DAU **40** / WAU **137** / MAU **130**, adoption **778/2165 (35.9%)**, Week 8 **11/53 (20.8%)** on **2026-06-29**, stickiness **30.8%**. WAU > MAU this week is real (IST week started 31 Aug). Do not "fix" it.

Production UI: `web/` on http://127.0.0.1:4832 (set `PRODUCT_METRICS_API_URL=http://127.0.0.1:4831`). Data plane: Python `metrics.api` on **4831**. Next route handlers already proxy to 4831 when that env is set (`proxyIfUpstream` in `web/lib/json-route.ts`). Add the same proxy line on every new Overview route.

If you change `metrics/api.py`, restart **4831 only**. Leave 4830.

---

## Do-nots (hard)

- No map. No gender/age pyramid. No nationality. No department/division. Those fields are not in the warehouse.
- No Mixpanel. No new event names. No engagement scores. No DAU "quality" index.
- Do not change activation / value / action / staff-filter meaning.
- Do not put SQL in the browser.
- Do not add Recharts / Chart.js / Nivo. SVG + CSS in `web/components/metrics/`. Chart chrome is sharp, no glow, no gradients, no 3D bubbles.
- Do not invent company size, plan type, or region.
- Recon is later/optional. Do not put Recon in the activation waterfall as a required step.
- `company_profile` is **activated companies only**. Funnel / vintage for not-yet-activated clients must use `client_company` + `events`.

---

## Signed metric contract (unchanged)

1. Active person = distinct `distinct_id` with ≥1 **ACTION** event, `company_id` in `client_company`, `NOT public.is_internal_email(email)`.
2. Windows = Asia/Kolkata. Week = Monday `date_trunc('week', … AT TIME ZONE 'Asia/Kolkata')`.
3. Adoption = activated / client_companies. Activation = first `Accounting Sync`.
4. Customer retention = latest mature Week 8. Mature = `cohort_week <= current IST Monday - 63 days`. Value = `Accounting Sync` OR `Recon Processed`.
5. Action set = `metrics.api.ACTION_EVENTS` (same as Retention). Login / Dashboard Viewed / Sign Up / chrome are not actions.

Action families (for mix charts only, do not rename events):

| family | event_name |
|---|---|
| upload | Upload, Mapping Completed, Saved Template Loaded |
| ap | Invoice Created, Invoice Bulk Edited, Download-Inv, Preview |
| txn | Transaction Ledger Updated, Transaction Status, Transaction Type Updated, Transaction Configuration Edited, Vendor Mismatch Resolved |
| sync | Accounting Sync |
| recon | Recon Processed |
| other | Entity Created, Delete, Download, Export |

---

## Layout

Keep `MetricsChrome` + title **Overview** + the existing four KPI cards.

Then a chart grid (desktop):

**Row 1 (Finances types)**

1. **Waterfall — Activation funnel** (Axis "Company Cost by Division").
2. **Clustered columns — Weekly actives** (Axis "Compensation TY & LY" / dual series).
3. **Horizontal grouped bars — This month vs last month** (Axis "Cost to Company" split bars).

**Row 2 (Demographics types)**

4. **Diverging bars — Vintage** (Axis "Employee by Demography" pyramid, without gender).
5. **Stacked columns — Monthly people composition** (Axis "Total Absenteeism").
6. **100% stacked — Week-8 by cohort** (Axis "Nationality vs EPM-IMM") + a compact **table** under or beside it (Axis quarterly table).

Optional if it fits without wrapping into a third noisy row: **treemap of action families this month** (Axis "Company Cost by Department"). Skip the bubble chart.

Mobile: stack cards, same order. Skeletons for each card while `/api/overview/charts` loads. Errors per card, not a blank page.

---

## Chart meaning and drill

Every labelled segment is a button. Click opens the Retention-style people drawer (`users` with nested `companies`). Click a company opens the existing company drill (`GET /api/companies/:id/summary` + timeline). Extract a shared drawer from `retention-explorer.tsx` if cheaper than duplicating. Do not build a second drill language.

### 1. Waterfall: Activation funnel (companies)

Universe: `client_company`.

Steps, remaining count (companies that reached at least this step):

1. `clients` — all client companies
2. `upload` — ≥1 `Upload` event
3. `ready` — ≥1 `Invoice Created` OR `Transaction Ledger Updated`
4. `sync` — row in `company_activation` (first Accounting Sync)

Waterfall drawing: start bar = clients. Each following bar is **remaining** after that step (same as remaining-at-step). Connector / drop labels show `dropped = previous - remaining`. Final bar is **Activated**, use `--chart-3` or `--chart-4` as the Total treatment (Axis yellow total). Do not include Recon here.

Click `sync` remaining → activated companies.
Click a drop segment (or the step bar with a `drop` modifier) → companies that reached the previous step and not this one.

Caption: "Client companies through first Accounting Sync. Recon is later and optional."

### 2. Clustered columns: last 12 IST weeks

Per week:

- `people` = distinct active people that week
- `companies` = distinct client companies with ≥1 action that week

Two series, values on or above bars if they fit. Current week included (in progress). Click a people bar → people active that week. Click a companies bar → those companies.

### 3. Horizontal grouped bars: this month vs last month

Three rows: DAU, WAU, MAU. Two colors: last month / this month.

Definitions (IST):

- This-month DAU = distinct people with an action on the current IST date (same as KPI DAU).
- This-month WAU / MAU = same as KPI.
- Last-month DAU = distinct people with an action on the **same calendar day last month**, clamped to last day's date if the day does not exist (31 Feb → last day of Feb). If you would rather avoid that clamp, use last month's **average daily uniques** for the DAU row instead of a single day, and say so in the subline. Prefer average daily uniques for the DAU compare row. WAU compare = unique people in the Monday week of last month that lines up with the current week start minus 28 days. MAU compare = unique people in the previous calendar month.

Subline must state the windows in dates (`as_of_date`, `month_start`, `prior_month_start`). Click a bar → people in that window.

### 4. Diverging bars: activated vs not, by first-seen month

Last 8 IST months. For each `client_company`, `first_seen` = `min(event_time)` (company signup clock is Company Created else first event; `min(event_time)` is the conservative first-seen used here). Bucket by `date_trunc('month', first_seen AT TIME ZONE 'Asia/Kolkata')`. Split: has `company_activation` vs not.

Left = not activated (`--destructive` or `--chart-2`). Right = activated (`--chart-4`). Counts inside bars. Click a side → those companies.

This replaces the gender pyramid. Do not label it demography.

### 5. Stacked columns: monthly people composition (last 6 months, closed months + current)

For each IST month M, people with ≥1 action in M, partitioned:

- `new` — their first-ever action month (any action event) is M
- `returning` — also had an action in month M-1
- `resurrected` — had an action before M, none in M-1

The three parts sum to MAU-for-that-month (unique people in M). Current month is in progress; mark it. Click a stack segment → those people.

### 6. 100% stacked: Week-8 by mature cohort

Last 8 **mature** activation weeks from `retention_cells` where `rel_week = 8` and `cohort_week <= current IST Monday - 63`. Two segments: retained / not retained. Counts in the tooltip or on-bar (`11/53`). Click retained → same membership as `GET /api/heatmap/cell?cohort_week=&rel_week=8`. Click not retained → companies in that cohort with no value in W+8.

Do not show immature cohorts here.

### 7. Table: last 12 weeks

Columns: week start, unique people, unique companies, new activations that week (`company_activation.activation_week`), Week-8 retained/size if that week's W+8 is mature else `—`.

Click a people or companies cell → same slice as chart 2.

### 8. Treemap (optional): action families this month

Rectangles sized by distinct people who fired that family this month. Click → people who did that family this month.

---

## API

Keep `GET /api/overview` as the four KPI payload. Do not break it.

Add `GET /api/overview/charts` → one JSON object with all series plus window stamps (`timezone`, `as_of_date`, `week_start`, `month_start`, `prior_month_start`). Mirror the payload in Next `web/lib/metrics-server.ts` and Python `metrics/api.py`.

Add `GET /api/overview/slice?chart=&key=` (and extra ids as needed):

| chart | key | extra | who is in the list |
|---|---|---|---|
| `funnel` | `clients` / `upload` / `ready` / `sync` | `mode=reached` or `mode=dropped` | companies (then people of those companies, staff emails out) |
| `weekly` | `people` / `companies` | `week=YYYY-MM-DD` (Monday) | people or companies active that week |
| `period` | `dau` / `wau` / `mau` | `which=current` / `prior` | people in that window |
| `vintage` | `activated` / `not_activated` | `month=YYYY-MM-01` | companies |
| `composition` | `new` / `returning` / `resurrected` | `month=YYYY-MM-01` | people |
| `week8` | `retained` / `dropped` | `cohort_week=YYYY-MM-DD` | companies; retained may reuse heatmap cell builder |
| `family` | `upload` / `ap` / `txn` / `sync` / `recon` / `other` | none (this IST month) | people |

Slice payload: same shape as heatmap cell `{ people_count, company_count, users: [{ email, distinct_id, companies: [...] }] }`. Staff emails out. Cap membership like the cell query (`CELL_COMPANY_LIMIT`). 400 on bad params.

TDD against scratch `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics`. Seed already has April 2026 events. Add IST-today / this-month action rows in the new tests (same pattern as `test_overview_active_users_action_only_excludes_staff`). Staff Upload must not appear. Dashboard Viewed must not count as active.

Python and Next must return the same keys. Next `web/app/api/overview/charts/route.ts` and `web/app/api/overview/slice/route.ts` with `proxyIfUpstream` first.

---

## Frontend

- `web/components/metrics/overview-explorer.tsx` composes KPIs + grid.
- Small SVG chart components under `web/components/metrics/charts/` (waterfall, clustered-columns, h-bars, diverging, stacked-columns, treemap). No animation library. Honor `prefers-reduced-motion`.
- Fetch `/api/overview` and `/api/overview/charts` in parallel after `/health`.
- Drawer: reuse Retention cell drawer + company drawer. Opening a company from Overview must still hit `/api/companies/:id/summary` and timeline.
- Captions under each card, 12px muted, stating the window and the unit (people vs companies).

---

## Verify

1. `TEST_DATABASE_URL=… .venv/bin/python -m pytest tests/test_api_heatmap.py tests/test_overview_charts.py -q` (new file is fine). All pass.
2. `cd web && npm run lint`.
3. `curl -sf http://127.0.0.1:4831/api/overview` still 40/137/130-ish and 778/2165 / 11/53.
4. `curl -sf http://127.0.0.1:4831/api/overview/charts` returns all series. Funnel `sync` remaining equals `activated` from `/api/overview`. Week-8 stacked last bar matches 11/53 on 2026-06-29.
5. Click waterfall Activated → company list of 778. Click Week-8 retained on 2026-06-29 → 11 companies, same as Retention heatmap cell.
6. Click a staff-looking email: none in the list.
7. 4830 still up. Overview and Retention top-bar buttons still switch pages.

Report files changed, the funnel remaining counts, and whether you shipped the treemap. Do not wait. Do not push GitLab.
