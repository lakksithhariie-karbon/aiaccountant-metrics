# Codex brief: Principal / Staff, Retention (live)

Date: 2026-09-05
Owner: Codex (Principal / Staff). You implement backend and frontend.
Reviewer: Distinguished Engineer (validates, verifies, fixes only if you miss). Operator decides product.
Working directory (hard): `/root/arena/Tazor/product-metrics`
Do not work in sibling dirs (`umbra/`, `zuben/`, `novae/`, etc).

You are not scaffolding a new app. The product exists. This session is to finish the live Retention explorer and keep metric meaning intact.

---

## What we are building

Internal **Product Metrics** for Korefi / AI Accountant (`https://app.aiaccountant.com/`).

Mixpanel is the tracker only (project Korefi Prod `3490984`, US, timezone **Asia/Kolkata**). Raw events live in **our Postgres** (Supabase `aia-all`). Dashboards **never** call Mixpanel. "Live" is about 60 minutes behind (hourly incremental).

This product is **Retention**, not a scorecard. One page:

1. Five **page-level** KPI cards (not cell-click stats).
2. Full-width **cohort heatmap** (activation week rows, Week 0–8 columns).
3. Click a cell → people/company drawer (users with nested companies).
4. Click a company → overlapping drill drawer (path, by-week, by-event, paged timeline).

Scorecard is **Soon**. Do not invent tiles, fake IA, or a second dashboard.

Visual source of truth: Codex HTML in `ui-design/` (Axis-style dark top bar, Montserrat, `--radius: 0`, dark default). Production UI: Next.js App Router in `web/` (already built). Python `metrics.api` is the only data plane.

---

## Do-nots (hard)

- Do not call Mixpanel, Composio, or any export client from the dashboard or API.
- Do not change `fetcher/`. Do not stop `scripts/incremental_loop.sh`. Do not parallelize Mixpanel export.
- Do not kill **4830**. Do not git commit unless Operator asks.
- Do not rewrite activation / value / action / staff-filter meaning.
- Do not put SQL in the browser. Do not query Mixpanel from Next server actions.
- Do not init shadcn/Next in the repo root. Do not move the app to a new `ui/` folder.
- Do not use L4W. Company mix in a cell is **that week**.
- Do not show staff emails. Do not include staff-only companies in derived metrics.
- Do not count Login / Dashboard Viewed / Sign Up / chrome / billing / phone / company-switch events as actions (timeline may still list them).

---

## Ports (do not collide)

| Port | Process | Role |
|---|---|---|
| 4830 | old `metrics.api` | leave running. Old explorer. **No** `/api/summary`. |
| 4831 | current `metrics.api` | warehouse API + static `ui-design/`. **This is the data plane.** |
| 4832 | Next `web/` | production Retention UI. Rewrites `/health` and `/api/*` to 4831. |
| 3000 | unrelated | do not bind here. |

Allowed range if you must move Next: **4832–4835**. Default Next rewrite: `PRODUCT_METRICS_API_URL=http://127.0.0.1:4831`.

If you change `metrics/api.py`, restart **4831 only** (`PORT=4831 .venv/bin/python -m metrics.api`). Leave 4830.

---

## Signed metric contract

Source: FigJam `https://www.figma.com/board/pNOMEJi1e5deRYQ5n6VnZg/product-metrics` node `27-649`. Specs: `docs/specs/2026-09-04-feature-map.md`, `docs/briefs/heatmap-interface.md`.

1. **Activation (company)** = first `Accounting Sync` with non-null `company_id`.
2. **Path:** Sign Up → Integration status → Upload → AP or Txn ready → Accounting Sync. Ready = `Invoice Created` **or** `Transaction Ledger Updated`.
3. **First value** = Accounting Sync.
4. **Week-8 retained** = activated in week W and a **value** event in calendar week W+8. Value = `Accounting Sync` **or** `Recon Processed` only.
5. Weeks: `date_trunc('week', event_time AT TIME ZONE 'Asia/Kolkata')` (Monday).
6. Mixpanel `company` column **is the UUID**. Display name = `properties->>'companyName'` stored on `company_profile.company_name`.
7. Join `company_id`. Null company_id is stored, excluded from company metrics.

**Staff:** emails `@karboncard.com` / `@korefi.ai`. Client company = at least one non-staff email. Staff-only companies out of derived tables. Staff on a real client company: company stays, staff emails hidden in people payloads.

**Company signup clock** = `Company Created` else first event. User signup = `Sign Up` else first event. **TTV** = first Accounting Sync minus company signup (`first_sync_at - signed_up_at`).

**Five KPI cards (page-level):**

1. Activated (count of `company_activation`; subline of `client_company`).
2. Activation rate = activated / client_companies (lifetime of client book).
3. Median TTV hours = `percentile_cont(0.5)` of TTV on `company_profile`.
4. Week-8 retention = **latest mature** rel_week=8 cell. Mature = W+8 calendar week has **fully elapsed** (`cohort_week <= current IST Monday - 63 days`). Not a matrix average. Not an in-progress cell.
5. Recon among activated = activated companies with `path_had_recon`.

Live sanity (2026-09-05, after staff-only drop): client_company **2159**, activated **775**, median TTV **4.6 h**, week-8 **11/53 (20.8%)** on cohort **2026-06-29**, recon among activated **109 (14.1%)**. If your numbers diverge a lot, you changed meaning. Stop and report.

Heatmap columns are labeled **Week 0–8**, not +0–+8.

---

## Data plane (already built)

Warehouse tables (refresh: `python -m metrics refresh`, client companies only):

`client_company`, `company_activation`, `company_week_value`, `retention_cells`, `company_profile`, `company_week_action`. Plus `public.events`.

API: `python -m metrics.api` (`metrics/api.py`). Connection reuse via `_db()`, `autocommit=True`. Do not reconnect per HTTP request.

Endpoints (contract in `docs/briefs/heatmap-interface.md`):

- `GET /health` → `{ok: true}`
- `GET /api/summary` → KPI payload. Field is **`week8_retained`**, not `week8_retained_count`.
- `GET /api/heatmap` → cells. Omits rel weeks whose calendar week has **not started**. Current week is included today (that is the bug below).
- `GET /api/heatmap/cell?cohort_week=YYYY-MM-DD&rel_week=0..8`
- `GET /api/companies/:id/summary`
- `GET /api/companies/:id/timeline?limit=100&offset=0` (default 100, max 500, newest first, no email)

Tests: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics .venv/bin/python -m pytest tests/test_api_heatmap.py -q`

TDD for any API change. Watch the new test fail, then implement. That database is scratch, not the live warehouse.

`retention_cells` is a full 0–8 cross join, including future weeks stored as 0 retained. Never treat "latest rel_week=8 row" as mature. Summary already filters. Heatmap must not present unclosed later weeks as real retention.

---

## Frontend (already built)

**Production:** `web/` Next.js App Router, React, Tailwind, shadcn-style primitives.

- Entry: `web/components/metrics/retention-explorer.tsx`
- Adapter: `web/lib/api.ts`, types `web/lib/types.ts`
- Rewrites: `web/next.config.ts` → 4831
- Run: `cd web && PRODUCT_METRICS_API_URL=http://127.0.0.1:4831 npm run dev -- --hostname 127.0.0.1 --port 4832`
- Open: http://127.0.0.1:4832
- `?down=1` API-down preview

Already wired: `/health` then `/api/summary` + `/api/heatmap`; cell/company/timeline fetch; race-safe drawers; that-week mix (not L4W); nav Retention + Scorecard Soon; week-8 card reads `week8_retained`; cell drawer unmounts on close.

**Visual reference (do not rebuild):** `ui-design/` HTML/CSS/JS, also served at http://127.0.0.1:4831. Keep Next visually aligned with this, not with the old sidebar-shell brief (`docs/briefs/2026-09-04-droid-next-shell.md` is stale for layout).

Legacy `web/index.html`, `web/app.js`, `web/styles.css` are the first explorer. Leave them. Do not serve them from Next.

Dark default is signed. Light toggle stays.

---

## This session: implement these changes

Operator wants the live page truthful. Do these, in order. Do not expand scope.

### 1. Heatmap: closed weeks only for Week 1–8 (backend)

Bug: refresh writes future/in-progress W+8 cells as 0 or partial. Summary correctly uses the last **closed** W+8 (29 Jun 2026 → 11/53). Heatmap still shows **6 Jul 2026 Week 8** as 3/45 because that observation week has started but not ended. That reads as churn. It is not comparable to the KPI.

Rule:

- **Week 0:** include if that calendar week has **started** (current week’s activations may fill in).
- **Week 1–8:** include only if that observation week has **fully elapsed**. Same closed-window idea as the week-8 KPI: `cohort_week + (rel_week + 1) * 7 <= current IST Monday` i.e. `cohort_week + rel_week*7 + 7 <= current_monday`.

So on Sat 5 Sep 2026 (IST Monday 31 Aug): last heatmap Week 8 is **29 Jun**, matching the KPI. 6 Jul Week 8 is omitted (shows `—` in the UI, already the missing-cell treatment). 31 Aug Week 0 stays.

Implement in `metrics/api.py` `_heatmap` SQL. Add a test next to `test_heatmap_omits_unstarted_rel_weeks` / `test_page_summary_uses_mature_week8` that a poison in-progress rel_week=8 cell is omitted while rel_week=0 for the current Monday is kept. Update `docs/briefs/heatmap-interface.md` one sentence so the contract matches.

Restart **4831** after the API change. Confirm `GET http://127.0.0.1:4831/api/summary` week8_cohort_week equals the latest heatmap rel_week=8 cohort_week.

### 2. Frontend: missing Week 1–8 cells stay `—`

`web/components/metrics/retention-explorer.tsx` already renders missing cells as `—`. Do not fabricate rates. Do not label them 0%. If copy is needed, one caption line: later weeks appear once that week has closed. Do not add a legend essay.

### 3. Keep labels honest

- Company row mix: **That week** (upload / txn / sync / recon from `*_that_week`). Never L4W.
- KPI week-8 subline uses `week8_retained` (fallback `week8_retained_count` is ok).
- Nav: Retention (active) + Scorecard Soon (disabled). No Overview / Engineering / AI Services / Business.

### 4. Do not restyle unless you break the signed shell

No new palette, no rounded cards, no scorecard, no Mixpanel date pickers. `--radius: 0`. Tokens in `web/app/globals.css` stay the Operator oklch set.

---

## Verify before you report done

1. `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics .venv/bin/python -m pytest tests/test_api_heatmap.py -q` (all pass, including the new closed-week test).
2. `curl -sf http://127.0.0.1:4830/health` still ok (you did not kill it).
3. `curl -sf http://127.0.0.1:4831/health` and `/api/summary` and `/api/heatmap`.
4. Latest heatmap `rel_week=8` cohort_week **equals** `week8_cohort_week` from summary.
5. `curl -sf http://127.0.0.1:4832/health` → `{ok:true}` via Next rewrite.
6. Open http://127.0.0.1:4832: five KPIs populated (not `—`), heatmap Week 8 last row matches the card, click that cell, open a company, Older/Newest on timeline (page 100, DOM cap 200). Esc/scrim closes and you can click the heatmap again (drawer actually unmounts).
7. `cd web && npm run lint && npm run build`.
8. Grep `web/` (not `node_modules`) for `L4W`, `mixpanel`, `week8_retained_count` as the only field, and Axis nav labels. Empty / already handled.

---

## Report back

- Files you changed.
- New test name and pytest count.
- Summary JSON week8 fields vs last heatmap week-8 cell.
- 4832 URL. Confirm 4830 still up.
- Anything you did not do.

If a requirement is ambiguous, implement the closed-week heatmap rule above and list the assumption. Do not wait.
