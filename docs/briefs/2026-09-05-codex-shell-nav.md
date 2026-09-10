# Codex follow-up: skeleton shells + sections menu

Date: 2026-09-05
Owner: Codex (Principal / Staff). Implement in `/root/arena/Tazor/product-metrics`.
Closed-week heatmap is signed. Do not reopen it. Do not kill 4830. Do not call Mixpanel. Do not git commit.

Production UI: `web/` on http://127.0.0.1:4832 (proxy 4831). Visual reference: `ui-design/`.

---

## 1. Skeleton shells instead of "Loading…"

Replace every loading string with a **layout skeleton** that matches the thing about to appear. Same chrome, empty bones, then swap to data. No spinners, no bounce, no glow, no extra indigo.

Surfaces (all of them):

- **KPI row** on first load: five cards keep labels + sublines; values are skeleton bars until `/api/summary` lands. Do not leave `—` as the loading state (`—` is only for true missing after a successful response).
- **Heatmap**: table chrome (headers Week 0–8, a handful of row bones + cell bones) until `/api/heatmap` lands. Then the real matrix.
- **Cell drawer**: open immediately on click. Show title/cohort line, then skeleton user blocks (label + meta + one company row) until `/api/heatmap/cell` lands.
- **Company drawer**: open immediately. Skeleton for path line, stats, two table blocks, timeline list until summary/timeline land.
- **Timeline Older/Newest**: keep the drawer, skeleton the list region only. Do not blank the whole company drill.

Rules:

- `--radius: 0`. Pulse/shimmer using existing `--muted` / `--border` / `--foreground` at low opacity. Honor `prefers-reduced-motion: reduce` (static bones, no animation).
- Keep `aria-busy="true"` and a visually hidden status ("Loading heatmap") for assistive tech. Visible copy must not say "Loading heatmap…".
- Errors stay as error text. Empty stays empty. Skeleton is loading only.
- Do not add a skeleton library. A small local component in `web/components/metrics/` is enough.

---

## 2. Restore the prototype sections menu

The hamburger is the product IA for **all** team metrics, not Retention-only. Put back the prototype list from `ui-design/index.html`:

- Overview
- Engineering & Delivery
- Product (current page, `aria-current="page"`, active)
- AI Services
- Business

Match the prototype full-page overlay (kicker "Sections", staggered rows, Product filled). Top bar can still say **Retention** as the page you are on.

This session: **chrome only**. Do not build Overview / Engineering / AI / Business pages and do not invent scorecard tiles. Those four items are placeholders (`aria-disabled` or `Soon` treatment like the prototype `.side-item.disabled`). Clicking them closes the menu and stays on Retention. When Operator asks, those become real routes.

Remove the "Retention / Scorecard Soon" hamburger list. Scorecard is not a section. It will live under Product later.

Also restore this list in `ui-design/` if you stripped it there, so HTML prototype and Next do not drift.

---

## Verify

1. No visible "Loading heatmap…", "Loading users…", "Loading company", "Loading timeline…" in `web/`.
2. Slow the API (or throttle) and confirm KPI / heatmap / cell / company / timeline all show bones then data.
3. Hamburger shows the five prototype sections; Product is active; the other four do not navigate away.
4. Closed-week still holds: `curl -sf http://127.0.0.1:4831/api/summary` week8_cohort_week equals latest heatmap rel_week=8 (currently 2026-06-29, 11/53).
5. 4830 still up. `cd web && npm run lint`. If Turbopack build hits the worker-port error, `npm run build -- --webpack`.

Report files changed and a screenshot-level note of skeleton + menu. Do not wait.
