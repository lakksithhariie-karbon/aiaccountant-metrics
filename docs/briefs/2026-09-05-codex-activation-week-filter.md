# Codex brief: activation-week filter

Date: 2026-09-05
Owner: Codex (Principal / Staff). Working directory `/root/arena/Tazor/product-metrics`.
Reviewer: Distinguished Engineer after you report done. Do not invent a different date meaning.

Do not kill 4830. Do not call Mixpanel. Do not git commit. Do not change activation / value / action / staff / closed-week formulas. Do not stop `scripts/incremental_loop.sh`. Do not touch `fetcher/`.

Production UI: `web/` at http://127.0.0.1:4832 (proxy 4831). Restart **4831 only** if you change `metrics/api.py`. Visual: Axis tokens, `--radius: 0`, no Mixpanel pickers, no rounded marketing cards.

---

## What this is

A filter on **which activation cohorts appear**. It clips heatmap **rows** (companies whose first Accounting Sync falls in the chosen weeks). It does not clip events by calendar day. Week 0–8 still means weeks since that company's activation.

Value is unchanged: Accounting Sync **or** Recon Processed.

---

## Placement (locked)

Put the control in the Retention **title row**, right side, where the quiet hint used to sit:

`Value = Accounting Sync or Recon Processed`

That slot is `.metrics-title-row` opposite `<h1 class="metrics-page-title">Retention</h1>`. CSS already has `justify-content: space-between` and `.metrics-hint`. Use that row. Do not put the filter in the top bar, hamburger, KPI row, or heatmap header.

Keep the Value definition. Move it to a heatmap caption under the grid (with the existing "Rows are activation cohort weeks…" lines):

`Value = Accounting Sync or Recon Processed`

Do not delete that sentence. It just leaves the title-row slot.

Mirror the same title-row control in `ui-design/` so the prototype does not drift.

---

## How it must function

### Grain

Both ends are **IST Mondays**. Parse `YYYY-MM-DD`. If the date is not Monday, snap to that week's Monday (`date - weekday()` with Monday = 0, same as `date_trunc('week', …)` in IST). Do not 400 a Thursday; snap it.

Range is **inclusive**: `from_week <= cohort_week <= to_week`.

Either bound omitted = unbounded on that side. Both omitted = current behavior (all cohorts). After snap, if `from_week > to_week`, HTTP 400 `{error: …}`.

### What it clips

| Surface | Follows the filter? |
|---|---|
| Heatmap rows | Yes. Existing closed-week WHERE stays; add `cohort_week` between bounds. |
| Week-8 KPI | Yes. Latest **mature** `rel_week = 8` cell whose `cohort_week` is still inside the range. Not a matrix average. Not an in-progress cell. |
| Activated, activation rate, median TTV, recon among activated, client_companies | **No.** Lifetime of the warehouse. Same numbers with or without the filter. |
| Cell / company / timeline APIs | **No.** A known `cohort_week` still loads. |

Closed-week rule is unchanged:

- Week 0 if that calendar week has started (`cohort_week <= current IST Monday`).
- Weeks 1–8 only if the observation week has fully elapsed (`cohort_week + rel_week*7 + 7 <= current IST Monday`).
- Mature Week 8: `cohort_week <= current IST Monday - 63 days`.

If the selected range has heatmap rows but **no** mature Week 8: `week8_cohort_week` is `null`, `week8_cohort_size` 0, `week8_retained` 0, `week8_retention` is `null` (UI shows `—`, not `0.0%`). Subline: `no mature week-8 cohort in this range.`

If the range has no rows: heatmap empty state. Lifetime KPIs still populated.

### Presets (UI)

Label: **Activation weeks**. Quiet helper (not a paragraph): `Companies that first synced in these weeks.`

1. **All** — omit both params. Default.
2. **Last 8** — the 8 most recent distinct `cohort_week` values that already have a started Week 0, then `from_week = min`, `to_week = max` of that set. If fewer than 8 exist, use all of them. **Not** "today minus 56 calendar days."
3. **Last 12** — same, 12 weeks.

No custom from/to date inputs. If the URL has from/to that is not All, Last 8, or Last 12, treat it as All.

Last 8 / Last 12 are computed from the **full** catalog of started Week-0 Mondays, never from the already-filtered grid (or you cannot widen back).

Catalog: `GET /api/summary` always returns `cohort_weeks`: sorted oldest-first list of Mondays that have a Week 0 cell with `cohort_week <= current IST Monday`. **Never clipped** by `from_week` / `to_week`.

### URL

Client query on 4832: `?from_week=YYYY-MM-DD&to_week=YYYY-MM-DD` (already-snapped Mondays). All = no params. Refresh restores the range. Do not put this on Mixpanel.

### Drawer behavior

If the open cell's `cohort_week` falls outside the new range, close the cell drawer and the company drawer. If it is still inside, leave them.

Changing the filter refetches `/api/heatmap` and `/api/summary` with the same params. Do not refetch company summary/timeline unless you closed that company.

---

## API

Shared parse helper. Same params on both endpoints.

`GET /api/heatmap?from_week=YYYY-MM-DD&to_week=YYYY-MM-DD`

Existing closed-week SQL **plus**:

```
AND (%(from_week)s IS NULL OR cohort_week >= %(from_week)s)
AND (%(to_week)s IS NULL OR cohort_week <= %(to_week)s)
```

`GET /api/summary?from_week=YYYY-MM-DD&to_week=YYYY-MM-DD`

- `client_companies`, `activated`, `activation_rate`, `median_ttv_hours`, `recon_count`, `recon_among_activated`: ignore params.
- Week-8 query: existing mature predicate **plus** the same `cohort_week` bounds.
- Add `cohort_weeks: string[]` (full catalog, see above).

Unfiltered `GET /api/summary` and `GET /api/heatmap` stay backward compatible. Existing tests must still pass without params.

Malformed date → 400, same style as `cohort_week must be YYYY-MM-DD`.

Do not add `preset=last_8` as an API param. UI computes from `cohort_weeks`.

---

## UI (`web/components/metrics/retention-explorer.tsx`)

Title row:

```
Retention                         [All] [Last 8] [Last 12]
                                  Companies that first synced in these weeks.
```

Use existing `Button`. Sharp corners. Compact, one row on desktop; wrap on small screens (`.metrics-title-row` already wraps). Preset that matches the current bounds is `aria-pressed`. If Last 8 and Last 12 coincide (fewer than 9 catalog weeks), both may read pressed; do not fight that.

Week-8 card: keep `latest mature cohort · {date} · x of n` when a mature cell exists in range. When `week8_retention` is null, value `—` and the subline above.

Wire `metricsApi.summary` / `heatmap` to pass the query string. Types in `web/lib/types.ts`.

Skeleton: title-row controls are chrome, not skeleton. KPI / heatmap skeletons unchanged.

---

## Tests (`tests/test_api_heatmap.py`)

TDD. Seed already has mature Week 8 = `2026-04-06` (4, 2). Add cases; do not weaken existing ones.

1. Unfiltered summary/heatmap unchanged (current tests).
2. `from_week=to_week=2026-04-06`: heatmap only that cohort's closed cells; summary lifetime KPIs unchanged; `week8_cohort_week == "2026-04-06"`.
3. Range that **excludes** `2026-04-06` but includes only later immature poison Week-8 rows: `week8_cohort_week` null, `week8_retention` null; lifetime `activated` still 4.
4. Thursday `from_week` snaps to that Monday; heatmap includes the Monday row.
5. `from_week > to_week` after snap → 400.
6. `cohort_weeks` on summary is the full started Week-0 list even when from/to clip heatmap.
7. Lifetime KPIs with params **equal** lifetime KPIs without params on the same seed.

Also: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics .venv/bin/python -m pytest tests/test_api_heatmap.py -q`

---

## Do-nots (this session)

- Do not filter `events.event_time`.
- Do not average Week 8 across selected rows.
- Do not change the other four KPI definitions.
- Do not add plan / path / geo filters.
- Do not query Mixpanel. Do not add a third date picker for "as of".
- Do not client-filter the heatmap after fetching all rows as the source of truth for Week 8. Week 8 must come from `/api/summary` with the same bounds.

Update the one-line API sentence in `docs/briefs/heatmap-interface.md` for the new query params and `cohort_weeks`. Do not rewrite activation/value.

---

## Verify

1. Pytest green, including new cases.
2. http://127.0.0.1:4832 title row shows the control; Value caption sits under the heatmap.
3. All = current grid. Last 8 = at most 8 rows, newest activation Mondays. Last 12 = at most 12. No custom date inputs.
4. Week-8 card follows the range; Activated / TTV / recon cards do not move.
5. Closed-week still holds on All: latest heatmap Week 8 equals unfiltered `week8_cohort_week` (live: 2026-06-29, 11/53).
6. 4830 still up. `cd web && npm run lint`.

Report files changed and the live Last-8 week8 cohort (date, x/n). Do not wait.
