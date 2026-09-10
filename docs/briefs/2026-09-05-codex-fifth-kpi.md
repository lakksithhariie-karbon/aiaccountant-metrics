# Codex follow-up: 5th KPI is not recon

Date: 2026-09-05
Owner: Codex. Working directory `/root/arena/Tazor/product-metrics`.
Do not kill 4830. Do not call Mixpanel. Do not git commit. Do not reopen closed-week heatmap.

Hamburger border on the open-menu button is already removed in `web/` (`topbarPlain`). Do not put the visible `topbar` border back on that trigger.

---

## Why not "sync among activated"

Activation **is** first `Accounting Sync`. `path_had_sync` is 775/775. A card "sync among activated" would always read 100% and look broken.

Cards 1–2 already tell the sync story (775 activated, 35.9% of 2,159).

## 5th card: Not yet synced

Replace **Recon among activated** with:

- Label: `Not yet synced`
- Value: `client_companies - activated` (live: 1,384)
- Subline: `client companies with no Accounting Sync.`

Frontend can compute it from existing `/api/summary` fields. No API change required. Keep `recon_count` / `recon_among_activated` in the payload (unused on this page is fine). Do not delete warehouse recon logic.

Do not invent a new sync definition.

## Heatmap `n` label

`n` is **companies that activated that week**, not users. Cell `11/53` is 11 retained companies of 53 activated companies.

Change the column header from `n` to `Companies`. Add one caption line: `n is companies, not users. Week 8 value = Accounting Sync or Recon Processed.`

---

## Verify

1. 5th KPI is Not yet synced, 1384 (or current `client_companies - activated`), not 14.1% recon.
2. Header says Companies. 29 Jun row still 11/53.
3. Hamburger trigger has no visible box border.
4. 4830 up. pytest still 18. `cd web && npm run lint`.
