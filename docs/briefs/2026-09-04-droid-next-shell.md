# Droid brief: Next.js + shadcn explorer shell

Date: 2026-09-04
Owner: Factory Droid (Staff / Principal), implementation only
Reviewer: Distinguished Engineer after you report done
Working directory (hard): `/root/arena/Tazor/product-metrics`

You are the orchestrator. Spawn workers. Do not implement the whole slice in one session.
Do not call Mixpanel or Composio. Do not change `fetcher/`. Do not stop `scripts/incremental_loop.sh`.
Do not git commit unless the Operator asks. Do not reset DB passwords.
Do not rewrite metric meaning. The Python API on **127.0.0.1:4830** stays the data plane.

---

## What this slice is

Replace the first-pass `web/` static explorer with a **Next.js + shadcn/ui (Radix)** app that uses the Operator’s design tokens and this shell:

```
+------------------+--------------------------------------+
|                  |  TOP BAR  (product name, health)     |
|  SIDEBAR         +--------------------------------------+
|  (nav)           |  FILTER HEADER                       |
|                  +--------------------------------------+
|                  |  MAIN  (heatmap + people + company)  |
+------------------+--------------------------------------+
```

**Shared separator (non-negotiable):** the sidebar and the top bar share **one continuous vertical line**. The sidebar is full height, from the top of the window to the bottom. The top bar, filter header, and main sit to the **right** of that line. Do not put a full-width top bar *above* the sidebar (that breaks the shared line). The line is `border-r` on the sidebar using `--sidebar-border` / `--border`. Horizontal rules under the top bar and under the filters are separate and must meet that vertical line in a clean T-junction (same token, 1px, no double-border).

`--radius: 0`. Sharp corners everywhere. Do not round cards, buttons, or inputs back to 0.5rem.

---

## Worker A: scaffold (blocks B/C)

From `/root/arena/Tazor/product-metrics`, create the Next app in a **new folder `ui/`**. Do **not** run init in the repo root (that would smash the Python tree).

Exact init (Operator command, plus name/cwd so it lands in `ui/`):

```bash
cd /root/arena/Tazor/product-metrics
pnpm dlx shadcn@latest init --preset b1ZhhFqM5 --base radix --template next -n ui --no-monorepo -y
```

If the CLI still prompts, add `-d` and/or `-f`. If `-n ui` is ignored and files appear in the repo root, **stop and report**. Do not mix Next config into `fetcher/` or `metrics/`.

If `pnpm` is missing, install it via corepack (`corepack enable && corepack prepare pnpm@latest --activate`) then retry. Do not switch to npm/yarn unless pnpm is impossible.

After init, **overwrite** `:root` and `.dark` in the generated globals CSS with the Operator tokens below. The preset may be close; the Operator tokens win. Keep whatever `@theme inline` / Tailwind v4 wiring the template generated, but the variable **values** must match.

Also set `--radius: 0` in both themes (already in the tokens).

Add shadcn primitives you will actually use (do not add the whole catalog):

```bash
cd ui
pnpm dlx shadcn@latest add sidebar button input table separator badge scroll-area -y
```

If `sidebar` is not in this preset, build the same geometry with a `aside` + tokens. Do not fake a glassy / rounded dashboard.

Leave `web/` in place until Worker C has the Next explorer working. Do not delete `web/` in this slice.

Python API stays on **4830**. Next dev server: **127.0.0.1:3000**. In `ui/next.config.ts` rewrite:

- `/api/:path*` → `http://127.0.0.1:4830/api/:path*`
- `/health` → `http://127.0.0.1:4830/health`

The browser only talks to `:3000`. No CORS gymnastics. Do not move the Python process off 4830.

Dev start: `cd ui && pnpm dev --port 3000 --hostname 127.0.0.1`

---

## Operator design tokens (paste exactly)

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

Use these via existing shadcn/Tailwind mappings (`bg-background`, `text-foreground`, `border-border`, `bg-sidebar`, `bg-primary`, chart-1..5). Do not introduce a second palette. No extra indigo, no gradients, no glow, no glass.

---

## Worker B: app shell (after A)

Files under `ui/` only.

Shell structure (names can vary):

- `app/layout.tsx` — fonts from the preset; wrap with the token theme. Light is default. Dark class on `<html>` is optional via a top-bar toggle; if you add it, use `next-themes` only if the template already has it.
- Left **sidebar** (~240px, `bg-sidebar`, full viewport height): product mark **Korefi** / **Product metrics**, then nav:
  - Retention (active)
  - Scorecard (disabled / coming, do not build tiles)
- Right column is a flex column: **top bar** then **filter header** then **main**.
- Top bar (~48–56px): page title `Retention`, API health (`GET /health` → ok / down). No fake avatars, no “Welcome back”.
- Filter header (~48–56px, `border-b`): controls listed in Worker C. Empty placeholders are OK until C wires data.
- Main: `flex-1 min-h-0 overflow-auto`, `bg-background`.

Visual rules:

- All chrome borders are `--border` / `--sidebar-border`, 1px solid.
- `--radius: 0` on the theme. If a shadcn component still rounds, override with `rounded-none`.
- Sidebar background `--sidebar`, not a shadow stack.
- Do not nest cards in cards. Do not add a marketing hero.

Ship a `/` route that shows the empty shell (nav + title + health + empty main) so layout can be checked before the explorer is ported.

---

## Worker C: port the explorer into the shell

Read first: `docs/briefs/heatmap-interface.md`, `web/app.js`, `web/index.html`.

Keep the **same API contract**. Fetch from same-origin `/api/heatmap`, `/api/heatmap/cell`, `/api/companies/:id/summary`, `/api/companies/:id/timeline`, `/health` (rewritten to 4830).

### Filter header (wire these)

- Search: email or company name (client-side on the loaded cell, same as current `web/`).
- Optional: show selected cohort week + rel week as text once a cell is clicked (`29 Jun 2026 · +8`).
- Do not add Mixpanel date pickers. Heatmap click is still the cohort selector.

### Main body

Reuse current explorer behavior, restyle with tokens/components:

1. **Heatmap** — cohort rows, +0..+8, retained/n and %. Selected cell uses `ring` / `bg-primary/10`, not a glow. Cohort label `3 Mar 2026`.
2. **People list** — users with nested companies: name, signup, lifetime_actions, active_weeks, actions_per_active_week, actions_that_week, path ticks, TTV. Staff emails already absent from API.
3. **Company drill** — path dates (signup → upload → ready → sync → recon), by-week table, by-event table, paged timeline newest-first, default 100, DOM cap 200, Older/Newest.

Layout inside main: heatmap on top (full width of main), then a two-column split **people | company** (or people above company if narrow). Do not put the heatmap in the sidebar.

Do not reimplement refresh SQL. Do not call Mixpanel.

Copy that still applies: value = Accounting Sync or Recon Processed; actions = upload/mapping/AP/txn/sync/recon/entity/delete/download/export; never count Login/Dashboard as actions.

---

## Worker D: validate last

1. `ui/` exists; repo root still has `fetcher/`, `metrics/`, `supabase/`.
2. `:root` in globals contains `--radius: 0` and `--primary: oklch(0.488 0.243 264.376)` (light).
3. Python tests still green: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/product_metrics .venv/bin/python -m pytest -q`
4. Python API still on 4830 (`curl -sf http://127.0.0.1:4830/health`). If you found it down, restart `PORT=4830 .venv/bin/python -m metrics.api` without changing its code unless a rewrite bug requires it.
5. `pnpm --dir ui dev --port 3000 --hostname 127.0.0.1` (or production `pnpm --dir ui build && pnpm --dir ui start --port 3000`).
6. `curl -sf http://127.0.0.1:3000/health` → `{"ok":true}` (via rewrite).
7. `curl -sf http://127.0.0.1:3000/api/heatmap | head` returns cells.
8. Open `http://127.0.0.1:3000`: screenshot-level check if you can; otherwise confirm the HTML contains the sidebar + topbar and one vertical shared border. Click a week-8 cell, open a company, timeline page length 100.
9. Grep `ui/` for mixpanel/composio; empty. No `rounded-3xl`, no gradient text, no indigo-500 unless it is the mapped `--primary`.

---

## Deviation tripwires (stop and report)

- Running shadcn init in the Python repo root.
- Changing activation/value/action definitions.
- Killing 4830 permanently or folding the API into Next server actions that query Mixpanel.
- Full-width top bar that sits *above* the sidebar (breaks the shared vertical line).
- `--radius` not 0, or a second color system besides the tokens above.
- Scorecard tiles (nav item only).
- Deleting `web/` before 3000 works.
- Git commit unless Operator asks.

---

## Done when

- `http://127.0.0.1:3000` shows the shell (sidebar | topbar / filters / main) with the shared vertical separator.
- Tokens match the Operator block, radius 0.
- Retention explorer works through Next rewrites to the existing API (heatmap → people → company path/frequency/timeline).
- 4830 still serves the old static `web/` (fine if unused) and `/api`.
- You report: init command that actually ran, `ui/` path, 3000 URL, 4830 health, pytest count, and one week-8 click result.

README: add a short “UI (Next)” section with `pnpm --dir ui dev --port 3000` and the rewrite to 4830. Do not remove the Python explorer commands yet.
