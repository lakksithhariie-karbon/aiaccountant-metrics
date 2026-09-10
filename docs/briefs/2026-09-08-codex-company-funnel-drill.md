# Codex brief: company drill funnel + property breakdown

Date: 2026-09-08
Owner: Codex. You implement. Distinguished Engineer reviews after you report
done. Operator does not want a design debate in this pass.
Working directory (hard): `/root/arena/Tazor/product-metrics`

Do not git commit / push unless Operator asks.
Do not print `.env`. Do not kill **4830**. Restart **4831 only** if you
change `metrics/api.py`, then check `/api/summary` week-8 is still
**2026-07-06, 4/45** (or the then-current mature cell; do not change the
formula). Leave 4832 running.

Locked by DE review of the 2026-09-08 proposal. Build that review. Do not
reopen signed metrics.

---

## Non-negotiable

- Activation = first `Accounting Sync` with non-null `company_id`.
- Ready = `Invoice Created` **or** `Transaction Ledger Updated` only.
- Week-8 value = `Accounting Sync` **or** `Recon Processed` only.
- Mixpanel `had_created_bill_or_txn` is a flag, not Ready.
- Recon is not an activation step. Do not put it on the new funnel ladder.
- Failed Upload does not set product flags (already true). Do not change that.
- Missing Upload `subType` stays missing. Do not invent `bank`.
- Dashboards never call Mixpanel. No SQL in the browser.
- Do not show staff emails. Timeline stays `event_time` + `event_name`.
- Do not add charts, scores, sessions, L4W, or Mixpanel people fields.
- Do not change heatmap SQL, Overview funnel keys, or `ACTION_EVENTS`.
- Dual data plane: `metrics/api.py` **and** `web/lib/metrics-server.ts`.
- Both company drawers: `web/components/metrics/metric-drill-drawers.tsx`
  and the copy in `retention-explorer.tsx`. Do not let them drift.

TDD: failing tests on scratch Postgres first. Then API. Then UI.

---

## What to build

Company drill, in this order:

1. Existing header + insight **stats** (TTV, last sync, last value week,
   week-8, lifetime actions). Keep those.
2. Replace the insight **Firsts** list with a vertical **funnel timeline**
   (milestone summary, not the raw log).
3. Lifetime **Work mix** table, labelled lifetime. Include AP. Do not
   compute mix in the browser from `by_week` if the server now sends it.
4. **Upload types** table.
5. **Ready activities** table.
6. **Ledger / txn** tables (event name first; `transactionType` only when
   the property exists).
7. Existing by-week table (not L4W).
8. Existing by-event table.
9. Existing paged timeline, unchanged below.

Use the current drawer shell, borders, radius, tokens. Interaction
pattern may follow the supplied 7ovr timeline (vertical milestones).
Do not copy its branding. Milestones must read without color
(Reached / Not reached in text).

---

## Funnel milestones (exactly these five)

1. Signup — use existing `signed_up_at` (Company Created / first event).
   Do not change that meaning.
2. Integration status — first `Integration status` event. This is **not**
   an action. Do not add it to `ACTION_EVENTS` or `by_event`.
3. Upload — first `Upload` (existing `first_upload_at`, includes Failed).
4. Ready — first Invoice Created or Transaction Ledger Updated.
5. Accounting Sync — first Accounting Sync.

Each row, computed on the server:

- `key`, `label`
- `reached`
- `first_at` (ISO or null)
- `count` (event count for that milestone; Signup may be 1)
- `gap_hours_from_prev` (null on first or if either side missing / end < start)
- `breakdown` (small list; empty for Signup / Integration if nothing useful)

New gaps (do not rename the old `hours_signup_to_upload` fields):

- signup → integration
- integration → upload
- upload → ready
- ready → sync

Old `hours_*` fields stay on the payload for the insight stats.

---

## Work mix (lifetime, labelled)

Server totals, same families as `company_week_action`:

- `upload` = Upload events
- `upload_failed` = Upload with `status=Failed`
- `ap` = AP family (`Invoice Created`, `Invoice Bulk Edited`,
  `Download-Inv`, `Preview`)
- `txn` = the five ledger/txn action events (not Ready-as-companies)
- `sync` = Accounting Sync
- `recon` = Recon Processed

Do not treat `txn` as number of companies that reached Ready.

---

## Upload types

Group this company's `Upload` events by `properties->>'type'`:

- `invoice`, `bill`, `statement`, `gstr2b`, `purchase_register`
- anything else non-empty: keep the stored type string (trimmed/lowered)
- missing / `""` → `unknown` (label **Unknown**)

Per row: `key`, `count`, `first_at`, `last_at`, `failed_count`.

Failed rows still increment `count` and `failed_count`. They still do
not set `had_*_upload` flags.

---

## Ready activities

Only:

- `Invoice Created`
- `Transaction Ledger Updated`

Count, first_at, last_at. Zero rows allowed.

---

## Ledger / txn

Event-name table, this order if present, then any extras from the five:

- `Transaction Ledger Updated`
- `Transaction Status`
- `Transaction Type Updated`
- `Transaction Configuration Edited`
- `Vendor Mismatch Resolved`

Then a second table of `transactionType` values **only where the key
exists**. Do not invent categories. Do not use UUID-looking values as
labels (skip or bucket as `other`; do not show raw UUIDs).

---

## API

Extend `GET /api/companies/:id/summary`. Do not add a second drill endpoint.

Add keys (names may match this shape; keep all existing `SUMMARY_KEYS`):

```json
{
  "funnel": [ { "key": "signup", "label": "Signup", "reached": true,
    "first_at": "", "count": 1, "gap_hours_from_prev": null,
    "breakdown": [] } ],
  "work_mix": {
    "scope": "lifetime",
    "upload": 0, "upload_failed": 0, "ap": 0, "txn": 0, "sync": 0, "recon": 0
  },
  "upload_types": [],
  "ready_activities": [],
  "ledger_events": [],
  "ledger_transaction_types": []
}
```

Funnel `key` values: `signup`, `integration`, `upload`, `ready`, `sync`.

---

## Tests (scratch DB, existing heatmap fixture)

Extend `tests/test_api_heatmap.py` `SUMMARY_KEYS`. Do not shrink it.

On `c_story`:

- funnel keys in order; `ready` and `sync` reached
- Ready table only those two event names
- Work mix `scope` is `lifetime`; `ap` >= Invoice Created count
- week-8 / activation fields unchanged

Add a focused seed (or extend fixture) for:

- Failed Upload counted in `upload_failed` and Upload type `failed_count`,
  and not as a product flag on `by_week`
- Upload with missing type → `unknown`
- `Integration status` first_at/count; that name absent from `by_event`
- `c_drop` still has null recon; funnel `sync` reached; Recon not a funnel key

Timeline tests: still no email, newest first, cap unchanged.

If you touch `metrics/api.py`, curl live 4831 summary week-8 after restart.

---

## Done when

You report:

- test command + pass count
- payload example for `c_story` (fixture) and one live company id
  (no emails)
- funnel does not include Recon
- 4830 still up; 4831 restarted only if Python changed
- 4832 company drawer shows the new sections without a second raw timeline
  above the pager
