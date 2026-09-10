# Korefi Product Metrics UI — design context for ChatGPT / Perplexity

Paste this whole file. You are designing screens, not writing code and not inventing metrics.

Date: 2026-09-04
Product: Korefi (also branded AI Accountant). App: https://app.aiaccountant.com/
This UI: internal **Product metrics** explorer for Korefi/Karbon operators. Not a customer-facing marketing site. Not Mixpanel.

Figma file to work in:
https://www.figma.com/design/0OtbJYU2zuCB5IknnlAfX3/Untitled?node-id=0-1

Target implementation later: Next.js + shadcn/ui (Radix), tokens below, `--radius: 0`. You design in Figma. Do not generate React.

---

## 1. What we are building

A **cohort retention explorer** over real product usage.

Korefi is an accounting product: companies sign up, connect integrations, upload bills/transactions, mark AP or txn ready, then run **Accounting Sync** (push to the books). Some also run **Recon**.

We copy Mixpanel events into our Postgres. Dashboards **never** call Mixpanel. Data is about 60 minutes behind. Timezone for week buckets: **Asia/Kolkata**, weeks start **Monday**.

This first product surface is **Retention** only. A later **Scorecard** (activation rate, median TTV, etc.) is a nav item that is **disabled / Soon**. Do not design scorecard tiles in this pass.

Audience: 1–3 internal operators who already know the metric definitions. UI should be dense, tabular, calm. Not a SaaS landing page, not a “welcome back” dashboard.

---

## 2. Metric contract (do not redesign this)

These meanings are signed. Labels and empty states must match them. Do not invent funnels, KPIs, or extra charts.

1. **Activation (company)** = first `Accounting Sync` with a non-null `company_id`.
2. **Activation path (for display, ticks not a second funnel):** Sign Up → Integration status → Upload → AP or Txn ready → Accounting Sync.
   Reconstruct “ready” as `Invoice Created` **or** `Transaction Ledger Updated`. Mixpanel’s custom event `Created Bill or marked txn a/c ready` is **not** in raw export.
3. **First value** = Accounting Sync (same event as activation).
4. **Week-8 retained** = company activated in calendar week W, and at least one **value** event in calendar week **W+8**. Value = `Accounting Sync` **or** `Recon Processed` only. Not Login, Dashboard, Upload, etc.
5. Heatmap: rows = activation cohort week. Columns = `+0` … `+8` (weeks since that cohort). Cell = retained companies / cohort size, plus %.
6. `company_id` is a UUID. Display name = Mixpanel `properties.companyName`.
7. Null `company_id` is stored in the warehouse but **excluded** from company metrics.

**Staff filter:** emails `@karboncard.com` / `@korefi.ai` (case-insensitive, including `Name <email>` and subdomains). A **client company** has at least one non-staff email. Staff-only companies are out of the explorer. Staff who also work on a real client company: company stays, staff emails are hidden. Companies with no email stay. Never show staff emails in the people list.

**Actions** (activity/frequency, not “value”): Upload, Mapping Completed, Saved Template Loaded, Invoice Created / Bulk Edited, Download-Inv, Preview, Transaction Ledger / Status / Type / Config, Vendor Mismatch Resolved, Accounting Sync, Recon Processed, Entity Created, Delete, Download, Export.

**Not actions:** Sign Up, Login, logout, Dashboard Viewed, Widget Clicked, Phone *, Company Created/Updated/Switched, Product Subscription, Billing Intent *. Those may still appear on the company **timeline log**.

Company signup clock = `Company Created` else first event on that company. User signup = `Sign Up` else first event. TTV hours = first Accounting Sync minus that company signup clock (null if no sync).

Live-ish counts (illustrative, for dummy data scale): ~2,159 client companies, ~775 activated, heatmap cells through +8. Example: cohort week of 29 Jun 2026 at +8 might show 11 retained of 48. Dummy data should look like that (tens per cohort, not millions).

---

## 3. Screens and states to design

Desktop **1440×900**. Light is default. Dark is required (same layout, `.dark` tokens). Font: **Geist** (Regular / Medium / SemiBold). Sharp corners: **radius 0**.

### App shell (every screen)

```
+------------------+--------------------------------------+
|                  |  TOP BAR                             |
|  SIDEBAR         +--------------------------------------+
|  full height     |  FILTER HEADER                       |
|                  +--------------------------------------+
|                  |  MAIN                                |
+------------------+--------------------------------------+
```

**Non-negotiable layout lock:** sidebar is full viewport height. Top bar, filters, and main sit to the **right**. They share **one continuous vertical 1px line** (`--sidebar-border`). Do **not** put a full-width top bar above the sidebar. Horizontal rules under the top bar and under the filters must meet that vertical line in a clean T-junction. No double borders.

- Sidebar ~240px, `bg-sidebar`.
- Top bar ~52px: page title **Retention** on the left; **API ok** or **API down** on the right (small status, not an avatar).
- Filter header ~52px, `border-b`.
- Main: heatmap full width of main, then a two-column split **people | company**.

**Sidebar content**
- Mark: **Korefi** / **Product metrics**
- Nav: **Retention** (active)
- Nav: **Scorecard** (disabled, label Soon). Do not design the scorecard page.

No fake avatars, no “Welcome back”, no user menu, no marketing hero, no nested cards in cards, no indigo gradients, no glow, no glass, no rounded-3xl, no emoji.

### Filter header

- Search input, placeholder: `email or company name…` (filters the loaded people list, not Mixpanel).
- Once a heatmap cell is selected, show the cohort as text: `29 Jun 2026 · +8`.
- Optional quiet hint: `Value = Accounting Sync or Recon Processed`.
- No Mixpanel date pickers. The heatmap click **is** the cohort selector.

### Frame A — Retention · idle

Heatmap visible with real-looking dummy cells. No cell selected.
- People: `No cell chosen. Click a heatmap cell to list people.`
- Company: `No company chosen. Pick a company in the cell list.`

### Frame B — Retention · cell selected (primary screen)

One cell selected (use **29 Jun 2026 · +8**). Selected cell: 1px `--ring` (or `--primary` at low opacity fill). Not a glow.

People column:
- Title: People in this cell
- Summary line: `{N} people · {M} companies · median {k} actions that week`
- User rows: **email** (never staff domains), signup, lifetime_actions, active_weeks, actions_that_week
- Nested companies under each user: **company name** (link), path ticks (Signup → Upload → ready → Sync {ttv}h → Recon if present), that-week mix (Upload / Txn / Sync / Recon counts)

Company column (after clicking a company name):
- Company name
- Path dates on one line: Signup · Upload · AP/Txn ready · Sync (TTV) · Recon
- Table **Actions by week**: Week, Actions, Upload, Txn, Sync, Recon
- **Timeline**: newest first, caption `Newest first · page 100`. Sample 4–6 events with `YYYY-MM-DD HH:MM` + event name. Buttons **Newest** and **Older**
- Timeline may include Login/Dashboard; the by-event/by-week tables must not treat those as actions

### Frame C — Retention · API down

Same shell. Top bar shows **API down**. Heatmap/people/company empty or a single error line. No retry circus.

### Frame D — dark of Frame B

Same geometry. Use `.dark` tokens. Do not leave a white panel on a dark chrome.

Scorecard page: **do not design**.

---

## 4. Heatmap visual rules

- Columns: `Cohort week | n | +0 … +8`
- Cohort label like `3 Mar 2026` or `29 Jun 2026` (not ISO in the grid)
- Cell: two lines, `retained/n` and `23%`. Tabular numbers
- Intensity: `--chart-1` … `--chart-5` at low opacity. Higher retention = stronger fill. Text stays `--foreground` (do not flip to white on mid blues unless contrast fails)
- Missing/future cells: muted, not clickable-looking
- Oldest cohorts at the top

Dummy rows are fine (4 May, 1 Jun, 8 Jun, 15 Jun, 29 Jun 2026). Keep cohort `n` in the 40–70 range.

---

## 5. Design tokens (exact)

`--radius: 0` everywhere: inputs, buttons, tables, sidebar, badges.

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
```

Use these names as Figma variables (`background`, `foreground`, `primary`, `sidebar`, `border`, …). Light and Dark modes on one collection.

---

## 6. Copy and dummy content

Product name in chrome: **Korefi**. Subtitle: **Product metrics**. Page: **Retention**.

Dummy emails: `ops@northwind.example`, `finance@glacier.example`. Never `@karboncard.com` or `@korefi.ai` in the people list.

Dummy companies: Northwind Traders, Glacier Labs.

Path example: `Signup 12 Apr · Upload 12 Apr · AP ready 12 Apr · Sync 12 Apr (4.2h) · Recon 29 Jun`

Timeline example (newest first):
- `2026-06-29 18:41  Recon Processed`
- `2026-06-29 18:12  Accounting Sync`
- `2026-06-29 17:04  Invoice Created`
- `2026-06-29 16:51  Upload`

Do not add Mixpanel logos, “powered by”, or made-up stats rows (MRR, DAU, etc.).

---

## 7. What to deliver

In the Figma file above, produce named frames:

1. `Retention · idle` (light)
2. `Retention · cell selected` (light) — this is the hero
3. `Retention · API down` (light)
4. `Retention · cell selected · dark`

Optional: one annotation frame listing the layout lock (shared vertical line) and metric one-liners. Do not replace the metric contract with a prettier definition.

When done, send node links (`figma.com/design/0OtbJYU2zuCB5IknnlAfX3/...?node-id=...`) for each frame.

---

## 8. Explicit do-nots

- Do not call Mixpanel from this UI or put Mixpanel date controls in the header.
- Do not design Scorecard tiles, settings, login, onboarding, or mobile-first (desktop first; 1440 is the spec).
- Do not round corners. Radius is 0.
- Do not introduce a second palette (no extra indigo, teal marketing, gold accents).
- Do not hide staff-looking emails in dummy data as if they belong.
- Do not treat Login / Dashboard Viewed as value or as heatmap retention.
- Do not put the heatmap in the sidebar.
- Do not put a full-width top bar above the sidebar.
