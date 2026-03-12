## Deployment

This version is designed for Vercel plus a remote Browserless browser, with Gold API plus FX as the backend fallback.

### Vercel

Deploy this repo to Vercel as a normal project.

Vercel uses:

- `index.html` for the frontend
- `api/prices.js` for `/api/prices`
- `api/health.js` for `/api/health`

### Required environment variables

Set one of these in Vercel:

- `BROWSERLESS_WS_URL`
- or `BROWSERLESS_TOKEN`

Optional:

- `BROWSERLESS_BASE_URL`
  - default: `wss://production-sfo.browserless.io`
- `NADIR_FUNCTION_TIMEOUT_MS`
- `GOLDAPI_GOLD_KG_USD_BUY_FACTOR`
- `GOLDAPI_GOLD_KG_USD_SELL_FACTOR`
- `GOLDAPI_GOLD_KG_EUR_BUY_FACTOR`
- `GOLDAPI_GOLD_KG_EUR_SELL_FACTOR`
- `GOLDAPI_GOLD_ONS_USD_BUY_FACTOR`
- `GOLDAPI_GOLD_ONS_USD_SELL_FACTOR`
- `GOLDAPI_GOLD_ONS_EUR_BUY_FACTOR`
- `GOLDAPI_GOLD_ONS_EUR_SELL_FACTOR`
- `GOLDAPI_SILVER_KG_EUR_BUY_FACTOR`
- `GOLDAPI_SILVER_KG_EUR_SELL_FACTOR`

Examples:

- `BROWSERLESS_WS_URL = wss://production-sfo.browserless.io?token=YOUR_TOKEN`
- or:
  - `BROWSERLESS_TOKEN = YOUR_TOKEN`
  - `BROWSERLESS_BASE_URL = wss://production-sfo.browserless.io`

### What to test after deploy

Open:

- `/api/health`
- `/api/prices`

Expected `/api/health`:

- `ok: true`
- `browserlessConfigured: true`
- `goldApiFallback.xauUrl`
- `goldApiFallback.xagUrl`
- `goldApiFallback.fxUrl`

Expected `/api/prices`:

- `provider: "nadirdoviz-browserless"` or `provider: "goldapi-fallback"`
- `rows.goldKgUsd`
- `rows.goldKgEur`
- `rows.goldOnsUsd`
- `rows.goldOnsEur`
- `rows.silvKgEur`

### Notes

- There is no Render, Netlify, or Docker requirement in this version.
- Browser execution happens through Browserless, not inside the Vercel function runtime.
- If Browserless fails, `/api/prices` falls back to Gold API plus USD/EUR FX and calibrates those values toward Nadir-style pricing.
- After at least one successful Nadir scrape, the fallback learns row-specific calibration from that last successful Nadir snapshot.
- `server.js` is no longer the deployment path for Vercel.
