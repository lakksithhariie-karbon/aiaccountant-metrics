# OpenCode brief: Korefi Product metrics HTML prototype

You are OpenCode, Distinguished Design Engineer. You own look, layout, interaction, and dummy content for an HTML prototype that a later engineer will port into Next.js + shadcn.

Date: 2026-09-05
Working directory: `/root/arena/Tazor/product-metrics`
Write scope (hard): **`ui-design/` only**. Create, edit, delete files only inside that folder. Never touch `fetcher/`, `metrics/`, `web/`, `supabase/`, `.env`, tests, or docs.

Read scope: the rest of the repo is allowed. Start with:

- `web/index.html`, `web/app.js`, `web/styles.css` (current explorer: behavior is right, look is not)
- `docs/briefs/heatmap-interface.md` (API shapes)
- `docs/specs/2026-09-04-feature-map.md` (event names)

Do not call Mixpanel. Do not start Python. Prototype must work **offline** from fixtures. Do not `fetch` `:4830` unless you also keep a fully working offline path.

---

## 1. What this product is

**Korefi** (also branded AI Accountant). Customer app: https://app.aiaccountant.com/

This UI is an **internal Product metrics explorer** for 1–3 Korefi/Karbon operators. Not customer-facing. Not Mixpanel. Not a marketing site.

Korefi is accounting software: a company signs up, connects an integration, uploads bills or bank txns, marks AP or txn ready, then runs **Accounting Sync** (push to the books). Some also run **Recon**.

We copy Mixpanel events into our Postgres. Dashboards never call Mixpanel. Data is about 60 minutes behind. Week buckets: **Asia/Kolkata**, weeks start **Monday**.

This prototype is **Retention** only. **Scorecard** (activation rate, median TTV, WAC, adopted, expansion) is a disabled nav item labeled Soon. Do not design scorecard tiles.

Existing `web/` is a first-pass explorer that already has the right information architecture. You restyle and re-shell it. You do not invent new KPIs, funnels, or charts.

---

## 2. Metric contract (signed — do not redesign)

Labels, empty states, and dummy numbers must obey this. If a prettier story fights the contract, the contract wins.

1. **Activation (company)** = first `Accounting Sync` with a non-null `company_id`.
2. **Path (display ticks, not a second funnel):** Sign Up → Integration status → Upload → AP or Txn ready → Accounting Sync.
   Ready = `Invoice Created` **or** `Transaction Ledger Updated`. Mixpanel custom event `Created Bill or marked txn a/c ready` is not in raw export.
3. **First value** = Accounting Sync (same event as activation).
4. **Week-8 retained** = activated in calendar week W, and at least one **value** event in calendar week **W+8**. Value = `Accounting Sync` **or** `Recon Processed` only. Not Login, Dashboard, Upload.
5. Heatmap: rows = activation cohort week (oldest at top). Columns = `+0` … `+8`. Cell = retained companies / cohort size, plus %.
6. `company_id` is a UUID. Display name = `companyName`. Null `company_id` is excluded from company metrics.
7. Heatmap `retained_count` for a cell must equal distinct companies in that cell’s people list.

**Staff:** emails `@karboncard.com` / `@korefi.ai` (case-insensitive, `Name <email>`, subdomains). Client company = at least one non-staff email. Staff-only companies are out of the explorer. Staff on a real client company: company stays, staff emails hidden. No-email companies stay. Dummy people list must never contain those staff domains.

**Actions** (activity/frequency, not value): Upload, Mapping Completed, Saved Template Loaded, Invoice Created / Bulk Edited, Download-Inv, Preview, Transaction Ledger / Status / Type / Config, Vendor Mismatch Resolved, Accounting Sync, Recon Processed, Entity Created, Delete, Download, Export.

**Not actions:** Sign Up, Login, logout, Dashboard Viewed, Widget Clicked, Phone *, Company Created/Updated/Switched, Product Subscription, Billing Intent *. They may appear on the company **timeline**. They must not appear in by-event totals or “actions that week”.

Company signup clock = `Company Created` else first event on that company. User signup = `Sign Up` else first event. TTV hours = first Accounting Sync minus that company signup (null if no sync).

Illustrative scale for fixtures: ~2,159 client companies, ~775 activated. Cohort `n` around 40–70. Example cell: **29 Jun 2026 · +8** → 11 retained of 48.

---

## 3. Your job: a reusable HTML prototype

Build a **clickable desktop prototype** in vanilla HTML + CSS + a little JS.

Later a different engineer will port it to Next.js + shadcn (Radix) with these same CSS variables. So:

- Use the Operator tokens as `:root` / `.dark` custom properties. Name them exactly (`--background`, `--sidebar-border`, …).
- Semantic structure that maps to the shell: `aside` sidebar, `header` top bar, `header` filter bar, `main`.
- Dummy JSON in a fixture file whose **keys match** `docs/briefs/heatmap-interface.md` (`cohort_week`, `rel_week`, `retained_count`, `users[].companies[]`, etc.).
- No React, no Next, no Tailwind CDN, no shadcn in this folder. Plain CSS. You may use a system/Geist font via `@font-face` or a Google fonts link for Geist.
- `--radius: 0`. Override any temptation to round inputs/buttons/tables.
- Prototype must be usable at **1440×900**. Desktop first. Do not design a mobile app.

### Suggested files (you may adjust names)

```
ui-design/
  README.md          (already there; update how to open)
  index.html         single app: all states
  styles.css         tokens + shell + heatmap + lists
  fixtures.js        dummy heatmap, cell, company summary, timeline
  prototype.js       click heatmap, search, company drill, theme, api-down
```

Serve with `python3 -m http.server 4173 --bind 127.0.0.1` from `ui-design/`. Confirm `index.html` opens without a bundler.

### Interaction (must work in the browser)

1. Load idle: heatmap visible, no cell selected, people and company empty copy.
2. Click a heatmap cell (default demo: 29 Jun 2026 +8). Cell selected. Filter header shows `29 Jun 2026 · +8`. People list fills. Company stays empty until a company is clicked.
3. Client-side search filters the loaded people list by email or company name (same as `web/`).
4. Click a company name: company column fills (path, by-week, by-event, timeline). Timeline Newest/Older paginates dummy events (page 100, DOM cap 200: for the proto, 8–12 dummy events and working buttons are enough).
5. Theme toggle in the top bar (optional but required for Frame D): `class="dark"` on `<html>`. Light is default.
6. A way to preview API down: query `?down=1` and/or a small control. Top bar **API down**. Main shows one error line. No retry circus.
7. Scorecard nav item is visible, disabled, not a link that goes anywhere.

Keyboard: heatmap cells and company names must be focusable. Search is a real `<input>`.

---

## 4. App shell (non-negotiable)

```
+------------------+--------------------------------------+
|                  |  TOP BAR     title + health [theme]  |
|  SIDEBAR         +--------------------------------------+
|  full height     |  FILTER HEADER   search + cohort     |
|  240px           +--------------------------------------+
|                  |  MAIN                                |
|                  |  heatmap (full width of main)        |
|                  |  people          |  company          |
+------------------+--------------------------------------+
```

**Shared separator:** sidebar is full viewport height. Top bar, filters, and main sit to the **right**. One continuous vertical 1px line (`border-right` on the sidebar using `--sidebar-border`). Do **not** put a full-width top bar *above* the sidebar. Horizontal rules under the top bar and under the filters meet that vertical line in a clean T-junction. Same token, 1px, no double border.

- Sidebar: `background: var(--sidebar)`. Mark **Korefi** / **Product metrics**. Nav: **Retention** (active, `--sidebar-accent`). **Scorecard** (disabled, muted, label Soon).
- Top bar ~52px: page title **Retention**. Right: **API ok** (small) or **API down** (`--destructive` text, no bouncing spinner). Optional theme toggle. No avatar, no “Welcome back”, no user menu.
- Filter header ~52px, `border-bottom`: search placeholder `email or company name…`. After cell select, cohort text `29 Jun 2026 · +8`. Quiet hint allowed: `Value = Accounting Sync or Recon Processed`. No Mixpanel date pickers. Heatmap click is the cohort selector.
- Main: `flex-1; min-height: 0; overflow: auto`. Heatmap on top, then two columns people | company (stack vertically only if you must below ~1100px; 1440 is the spec).

---

## 5. Main content, field by field

### Heatmap

Columns: `Cohort week | n | +0 | +1 | … | +8`

- Cohort label: `29 Jun 2026` (not raw ISO in the grid). Helper in `web/app.js`: `cohortLabel`.
- Cell: two lines, tabular nums: `11/48` and `23%` (or one decimal like the live UI: `22.9%` is fine; pick one and stay consistent).
- Intensity: `--chart-1` … `--chart-5` at low opacity from rate. Text stays `--foreground` unless contrast fails.
- Selected: 1px `--ring` or `--primary` fill at ~10% opacity. Not a glow, not a green outline (the old `web/` used green; we do not).
- Missing/future: muted, not clickable.
- Empty whole table copy: `No retention data yet. The heatmap is empty. Try reloading in a little while.`
- Caption: `Rows are activation cohort weeks (oldest first). Columns are weeks since activation (0–8).`

Use 5 dummy cohort rows in the 40–70 `n` range. Include **29 Jun 2026**.

### People in this cell

Empty: `No cell chosen. Click a heatmap cell to list people.`

Filled header: `{people_count} people · {company_count} companies · median {median_actions_that_week} actions that week`

Per user:

- email
- `Signed up {date} · {lifetime_actions} lifetime actions · {active_weeks} active weeks · {actions_that_week} that week`

Per nested company:

- company name (button/link)
- path ticks: upload / ready / sync / recon
- TTV if present (`4.2 h`)
- that-week mix: Upload, Txn, Sync, Recon counts

### Company drill

Empty: `No company chosen. Pick a company in the cell list.`

Filled:

- Company name
- Path dates one line: Signup · Upload · AP/Txn ready · Sync (TTV) · Recon
- Optional stats line from profile (lifetime actions, active weeks)
- Table **Actions by week**: Week, Actions, Upload, Txn, Sync, Recon
- Table **Actions by event**: Event, Count (actions only, desc). No Login, no Dashboard Viewed.
- **Timeline**: newest first. Caption `Newest first · page 100`. Rows: `YYYY-MM-DD HH:MM` + event name. Buttons **Newest** and **Older**. Timeline may include Login.

### Dummy content (use these)

Emails: `ops@northwind.example`, `finance@glacier.example`  
Never `@karboncard.com` or `@korefi.ai`.

Companies: Northwind Traders, Glacier Labs.

Path: `Signup 12 Apr · Upload 12 Apr · AP ready 12 Apr · Sync 12 Apr (4.2h) · Recon 29 Jun`

Timeline:

- `2026-06-29 18:41  Recon Processed`
- `2026-06-29 18:12  Accounting Sync`
- `2026-06-29 17:04  Invoice Created`
- `2026-06-29 16:51  Upload`

Plus a couple of older pages so Older/Newest do something.

---

## 6. Visual rules (anti-slop)

This will be looked at for real. If it looks like a generic AI dashboard, you failed.

- One accent: `--primary` (blue-violet). Charts use `--chart-1`…`5` only.
- `--radius: 0` on everything.
- Borders: 1px `--border` / `--sidebar-border`. No shadows, no glass, no blur, no gradients on text, no indigo-500 unless it is the mapped primary.
- No emoji. No fake avatars. No 01/02/03 markers. No nested cards in cards. No “insight” marketing sentences.
- Type: Geist if you can load it; otherwise the system UI stack. Not Inter-as-a-brand, not Space Grotesk, not serif-italic kickers.
- Status: API ok is quiet text, not a glowing green orb animation. A 8px static dot is enough.
- Heatmap is a table, not a D3 art piece.

---

## 7. Design tokens (paste into CSS exactly)

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.488 0.243 264.376);
  --primary-foreground: oklch(0.97 0.014 254.604);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.015 286.067);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --radius: 0;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.546 0.245 262.881);
  --sidebar-primary-foreground: oklch(0.97 0.014 254.604);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.705 0.015 286.067);
}

.dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.424 0.199 265.638);
  --primary-foreground: oklch(0.97 0.014 254.604);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.552 0.016 285.938);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.623 0.214 259.815);
  --sidebar-primary-foreground: oklch(0.97 0.014 254.604);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.552 0.016 285.938);
}

html, body { background: var(--background); color: var(--foreground); }
```

---

## 8. API shapes fixtures should mimic

You are not wiring the live API. Fixtures should still look like:

- `GET /health` → `{ ok: true }`
- `GET /api/heatmap` → `[{ cohort_week, rel_week, cohort_size, retained_count, rate }]`
- `GET /api/heatmap/cell?cohort_week=YYYY-MM-DD&rel_week=8` → people payload in heatmap-interface.md
- `GET /api/companies/:id/summary` → profile + `by_week` + `by_event`
- `GET /api/companies/:id/timeline?limit=100&offset=0` → `{ total, limit, offset, events: [{ event_time, event_name }] }` no email

`company_count` in a cell equals heatmap `retained_count` for that cell.

---

## 9. Explicit do-nots

- Write anything outside `ui-design/`.
- Call Mixpanel, Composio, or change Python.
- Full-width top bar above the sidebar.
- Heatmap in the sidebar.
- Scorecard page or KPI tiles.
- `--radius` other than 0.
- A second color system.
- Staff emails in dummy people.
- Login/Dashboard as value or as heatmap retention.
- Git commit unless the Operator asks.

---

## 10. Done when

- `ui-design/index.html` opens without a bundler.
- Shared vertical line is visible (sidebar full height, T-junctions).
- Click week-8 cell → people. Click company → path + by-week + by-event + timeline.
- Search filters people. Theme toggle. `?down=1` (or equivalent) shows API down.
- Tokens match the block above, including `--radius: 0` and light `--primary: oklch(0.488 0.243 264.376)`.
- README in `ui-design/` says how to open it.

Report: file list, how to open, and the click path you verified (idle → +8 → company → Older).
