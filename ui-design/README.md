# ui-design

Codex owns this directory. Retention HTML for Korefi Product metrics.

Live (warehouse via Python API): http://127.0.0.1:4831

```bash
cd /root/arena/Tazor/product-metrics
PORT=4831 .venv/bin/python -m metrics.api
```

Same-origin: `/health`, `/api/summary`, `/api/heatmap`, `/api/heatmap/cell`, `/api/companies/:id/summary`, `/api/companies/:id/timeline`.

Offline fixtures (design review, no warehouse): http://127.0.0.1:4831/?offline=1

API-down screen: `?down=1`

Files: `index.html` (Axis-style shell), `styles.css`, `fixtures.js` (offline dummy), `prototype.js` (live fetch + drawers).

Click path: heatmap cell → people/company drawer → company drill → Older/Newest on timeline. Esc or scrim closes.

Theme: Light button toggles `class="dark"` on `html`. Default is dark.

Do not invent scorecard tiles. The sections menu is shared team-metrics chrome: Overview, Engineering & Delivery, Product, AI Services, and Business. Retention is the current Product view; the other sections are placeholders until their routes exist.
