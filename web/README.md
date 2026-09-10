# Korefi Product Metrics web app

Next.js App Router shell for the Retention explorer. Codex owns this UI. Python `metrics.api` stays the data plane.

## Run locally

Live warehouse API is already on **4831**. Do not stop 4830 or 4831.

```bash
cd /root/arena/Tazor/product-metrics/web
PRODUCT_METRICS_API_URL=http://127.0.0.1:4831 npm run dev -- --hostname 127.0.0.1 --port 4832
```

Open http://127.0.0.1:4832

Default rewrite target is `http://127.0.0.1:4831` (`/health`, `/api/summary`, heatmap, cell, company, timeline). Override with `PRODUCT_METRICS_API_URL` if needed. 4830 is the older explorer process and does **not** serve `/api/summary`.

API-down preview: `?down=1`

## Validate

```bash
npm run lint
npm run build
```

The legacy `index.html`, `app.js`, and `styles.css` files remain here as the original behavior reference. The signed HTML prototype is in `../ui-design/`.
