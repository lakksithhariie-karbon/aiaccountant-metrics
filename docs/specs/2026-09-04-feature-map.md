# Feature map (Korefi / AI Accountant)

Date: 2026-09-04
Status: draft for Operator sign-off
Source: `public.events` on aia-all after L6M backfill (2026-03-04 → 2026-09-04, 346,431 rows, 42 event names)
Depends on: Mixpanel export warehouse (done)
Blocks: retention cells, heatmap, explorer, scorecard

This file is the contract for what each Mixpanel event *means* in product language. Droid (or anyone) building the heatmap must not invent a second mapping.

## Sign-off needed

Reply yes / change to these four calls. Until then, treat them as the working default (they match the Mixpanel funnel `Activation Funnel since Nov 20`, funnel_id `87987303`).

1. **Activation (company):** first `Accounting Sync` for that `company_id`.
2. **Activation path (ordered, not skipped):** `Sign Up` → `Integration status` → `Upload` → AP or Txn ready (see below) → `Accounting Sync`.
3. **First value:** `Accounting Sync` (same as Mixpanel today).
4. **Week-8 retained:** activated in week W, and at least one **value** event in week W+8. Value events = `Accounting Sync` or `Recon Processed` (say if recon-only should not count).

Mixpanel’s custom event `Created Bill or marked txn a/c ready` (`$custom_event:2025159`) does **not** appear in Raw Export. Reconstruct it as: `Invoice Created` **or** `Transaction Ledger Updated`.

## How to join

Prefer `company_id`. If it is null, the event is still stored but it does not count in company metrics.

Known holes in L6M (company_id always or almost always null): `Company Switched`, all Phone * events, Billing Intent *, `Duplicate Phone Attempt`, `logout` is fine (has company on most rows). `Product Subscription` has company_id on every row.

`distinct_id` is the user key. `$user_id` / `userId` / `ucUuid` / `email` are on the row when Mixpanel sent them.

## Event → area

Counts are L6M row counts. **Value** means it can keep a company “alive” in retention. **Activation step** means it is on the path above.

| Event | Area | Role | L6M rows | Notes |
|---|---|---|---:|---|
| Sign Up | Auth | activation step | 1366 | Start of Mixpanel funnel. |
| Login | Auth | session | 4337 | Not activation. |
| logout | Auth | session | 2124 | |
| Phone OTP Sent | Auth | friction | 693 | No company_id. |
| Phone OTP Verification Attempted | Auth | friction | 669 | |
| Phone Verification Completed | Auth | friction | 652 | |
| Phone Verification Required | Auth | friction | 575 | |
| Phone OTP Resent | Auth | friction | 18 | |
| Phone OTP Failed | Auth | friction | 17 | |
| Duplicate Phone Attempt | Auth | friction | 72 | |
| Phone Verification Locked | Auth | friction | 1 | |
| Company Created | Company | setup | 2281 | More than Sign Up in this window (creates from before L6M still fire, or staff/system). |
| Company Updated | Company | setup | 441 | |
| Company Switched | Company | session | 9306 | No company_id in export. Do not use for company metrics until we have another join. |
| Integration status | Integration | activation step | 965 | Funnel step 2. |
| Upload | Ingest | activation step | 62012 | Funnel step 3 (bill or txn file). |
| Mapping Completed | Mapping | setup | 1580 | |
| Saved Template Loaded | Mapping | setup | 128 | |
| Entity Created | Master | setup | 26756 | Chart of accounts / entity, not first value. |
| Invoice Created | AP | AP-ready; funnel step 4 | 258 | Rare vs txn path. |
| Invoice Bulk Edited | AP | AP | 1101 | |
| Download-Inv | AP | AP | 3 | Extra name, not in original 40. |
| Preview | AP | AP | 3 | Extra name, not in original 40. |
| Transaction Ledger Updated | Txn | txn-ready; funnel step 4 | 70700 | Dominant “ready” event. |
| Transaction Status | Txn | txn | 63355 | |
| Transaction Type Updated | Txn | txn | 37073 | |
| Transaction Configuration Edited | Txn | txn | 406 | |
| Vendor Mismatch Resolved | Txn | txn | 1059 | |
| Accounting Sync | Sync | **first value**; activation | 17028 | Funnel step 5. |
| Recon Processed | Recon | **value** | 861 | Sparse. GST adopted Mixpanel cohort was 0. |
| Dashboard Viewed | Surface | engagement | 23766 | Not value. |
| Widget Clicked | Surface | engagement | 6521 | |
| Download | Surface | export | 1418 | |
| Export | Surface | export | 387 | |
| Delete | Surface | edit | 5766 | |
| Product Subscription | Billing | commercial | 2626 | Not activation. |
| Billing Intent Created | Billing | commercial | 33 | No company_id. |
| Billing Intent Reserved | Billing | commercial | 29 | |
| Billing Intent Claimed | Billing | commercial | 18 | |
| Billing Intent Refreshed | Billing | commercial | 14 | |
| Billing Intent Failed | Billing | commercial | 12 | |
| Billing Intent Recovered | Billing | commercial | 1 | |

## Metric recipes (from this map)

These are definitions only. No tables built in this spec.

- **Activation rate:** companies with `Company Created` (or first seen `company_id`) that later have `Accounting Sync`, in a cohort window.
- **Median TTV:** median `event_time(Accounting Sync) - event_time(Sign Up or Company Created)` per company. Pick the start event in sign-off.
- **Weekly active companies (WAC):** distinct `company_id` with any event in the week, excluding Auth-only and Billing-intent-only if you want “product WAC”. Default proposal: any event with non-null `company_id` except Billing Intent *.
- **Adopted:** activated and at least one of `Recon Processed` or a second week of `Accounting Sync`. (Mixpanel had an Adopted Users cohort of 66. We should recreate from rows, not from Mixpanel.)
- **Week-8 retention:** see sign-off item 4.
- **Expansion:** `Product Subscription` after activation, or a later Billing Intent Claimed. Weak until billing events carry `company_id`.
- **Recon:** companies with `Recon Processed` / activated companies.

## Out of Mixpanel

Still true: support contacts and roadmap-to-outcome are not in this table.

## What Droid may build after sign-off

1. SQL for weekly company activity, activation week, week-8 matrix (`company_id × week`).
2. Heatmap UI that clicks a cell and lists companies from **our** tables, not Mixpanel.
3. Do not add new event-name meaning without editing this file.

Do not start that until Operator replies on the four sign-off items.
