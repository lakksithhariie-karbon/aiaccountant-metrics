# Event property dictionary v1

Date: 2026-09-07
Status: locked for Codex property enrichment
Version: `event_properties.v1`

This is the only allowlist. Do not add keys without Operator + DE. Do not
restore the pre-slim Mixpanel blob.

Identity stays on columns (`insert_id`, `event_name`, `event_time`,
`distinct_id`, `user_id`, `uc_uuid`, `email`, `company_id`, `company`).
Never copy those into `properties` except `companyName`.

## Keep (scalar, analytics)

| key | type | cardinality | sensitive | used by |
|---|---|---|---|---|
| companyName | text | high | no | display name |
| type | text | low | no | Upload/Download/Delete/Export/Integration/Ledger/Status; custom AP/Txn/GST |
| subType | text | mixed | no | Upload; Overview uses normalized bucket only |
| status | text | low | no | Success/Failed; Mixpanel ready uses Accounting Ready |
| fileType | text | low | no | Upload/Export |
| source | text | low | no | statement Header/Ledger; txn source |
| entityType | text | low | no | Entity Created; Active User (AP) |
| transactionType | text | mixed | no | Ledger; normalize casing |
| action | text | low | no | Save / Save & Mark as Accounting Ready |
| productCode | text | low | no | aia / gstr |
| widgetName | text | low | no | Widget Clicked |
| flow | text | low | no | Sign Up / Login |
| method | text | low | no | CREDENTIALS / GOOGLE / MICROSOFT |
| viewSource | text | low | no | Dashboard Viewed |
| isReactivation | bool | 2 | no | Product Subscription |
| items_count | number | low | no | Accounting Sync |

`type` on Download includes `reconciled_excel` (GST custom event).

## Drop (v1)

`fileName`, `sync_items`, `from`, `to`, `bankLineUuid`, `gstin`,
`periodFrom`, `periodTo`, `outcome`, `stage`, `reason`,
`attemptsRemaining`, `productUuid`, `userUuid`, `createdBy`,
`fromCompanyId`, `fromCompanyName`, `toCompanyId`, `toCompanyName`,
`organisationId`, `toolConnected`, `configField`, `newState`,
`previousState`, `pageName`, `templateType`, `tool`, `transactionCount`,
`itemsCount`, `signUpDate`, `signUpMethod`, `billingExpected`,
`timestamp`, Mixpanel `$` / `mp_` reserved.

## Normalization (store canonical in jsonb)

- `type`: trim, lower. Map `gst2b` → `gstr2b`.
- `subType`: trim, lower. Keep `bulk`, `single`, `gst_reconciliation`.
  Anything else on Upload → `bank`.
- `fileType`: keep MIME string; do not invent labels.
- `status`: trim. Do not lower `Accounting Ready` (Mixpanel formula is exact).
  Map only exact `success`/`failed` casings to `Success`/`Failed`.
- `transactionType`: trim, lower (`Payment` → `payment`). UUID values stay
  as-is; do not use UUIDs in Overview.
- `entityType`, `productCode`, `action`, `method`, `flow`, `viewSource`,
  `widgetName`: trim; do not invent aliases.
- `isReactivation`: JSON boolean.
- `items_count`: number; drop non-numeric.
- Event names: exact Mixpanel strings. `Txn Category Updated` is historical
  and mostly absent. `Transaction Type Updated` is the live event.
  `Configuration Completed` may be empty in L6M. Formulas that name those
  events still include them; zero rows is allowed.

## Signed metrics (do not change)

- Activation = first `Accounting Sync` with non-null `company_id`.
- Ready = `Invoice Created` OR `Transaction Ledger Updated`.
- Week-8 value = `Accounting Sync` OR `Recon Processed`.
- Mixpanel custom event **Created bill or txn** is a **separate** flag
  (`had_created_bill_or_txn`). It is Entity Created `entityType=bill` OR
  Transaction Status `status=Accounting Ready`.

## Custom-event flags (company × IST week)

Materialize `company_week_product` after properties exist. Do not insert
fake `event_name` rows.

A company may have several flags true in the same week.

| flag | Mixpanel formula |
|---|---|
| had_uploaded_excel | Upload `type=invoice` |
| had_ap_active | Entity Created `entityType=bill` OR Upload/Download `type=bill` |
| had_txn_active | Upload/Download `type=statement` OR Transaction Status OR Txn Category Updated |
| had_gst_recon | Upload `type in (gstr2b, purchase_register)` OR Recon Processed OR Download `type=reconciled_excel` |
| had_created_bill_or_txn | Entity Created `entityType=bill` OR Transaction Status `status=Accounting Ready` |
| had_bill_upload | Upload `type=bill` |
| had_invoice_upload | Upload `type=invoice` |
| had_statement_upload | Upload `type=statement` |

Failed uploads (`status=Failed`) do not set upload flags.

Company-level only. Do not mix `user_profiles.userRole` into these
denominators or into week-8.

## Coverage gate

Before Overview splits: share of Uploads with non-null `type` on a recent
IST week must be reported. If coverage is weak, do not ship UI splits.
