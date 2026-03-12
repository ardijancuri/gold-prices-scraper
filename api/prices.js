const { chromium } = require('playwright-core');
const {
  TARGET_URL,
  GOLD_API_XAU_URL,
  GOLD_API_XAG_URL,
  FX_API_URL,
  mapExtractedRows,
  transformNadirRows,
  buildRawGoldApiRows,
  deriveCalibrationProfile,
  buildGoldApiFallbackRows,
  parseGoldApiPrice,
  parseFxUsdEur,
  getBrowserlessWsUrl,
  isNadirDisabled,
  withTimeout
} = require('./_shared/prices');

const FUNCTION_TIMEOUT_MS = Number(process.env.NADIR_FUNCTION_TIMEOUT_MS || 25_000);

const cache = {
  provider: null,
  rows: null,
  fetchedAt: null,
  lastSuccessAt: null
};

const calibrationState = {
  profile: null,
  lastNadirRows: null,
  updatedAt: null
};

function writeSuccess(res, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(payload);
}

function storeSuccess(provider, rows) {
  const fetchedAt = new Date().toISOString();
  cache.provider = provider;
  cache.rows = rows;
  cache.fetchedAt = fetchedAt;
  cache.lastSuccessAt = fetchedAt;
  return {
    provider,
    fetchedAt,
    lastSuccessAt: fetchedAt,
    cached: false,
    stale: false,
    rows
  };
}

function buildStalePayload() {
  if (!cache.rows) {
    return null;
  }
  return {
    provider: cache.provider,
    fetchedAt: cache.fetchedAt,
    lastSuccessAt: cache.lastSuccessAt,
    cached: true,
    stale: true,
    rows: cache.rows
  };
}

function getStalePayloadForMode(nadirDisabled) {
  const payload = buildStalePayload();
  if (!payload) {
    return null;
  }
  if (nadirDisabled && payload.provider !== 'goldapi-fallback') {
    return null;
  }
  return payload;
}

async function fetchJson(url, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadFromBrowserless() {
  const wsUrl = getBrowserlessWsUrl();
  if (!wsUrl) {
    throw new Error('Browserless is not configured.');
  }

  let browser;
  try {
    browser = await withTimeout(chromium.connectOverCDP(wsUrl), FUNCTION_TIMEOUT_MS, 'remote browser connection');

    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    await withTimeout(
      page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' }),
      FUNCTION_TIMEOUT_MS,
      'initial page load'
    );

    await withTimeout(
      page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return text.includes('AltÄ±nKG/USD') || text.includes('AltinKG/USD');
      }, { timeout: FUNCTION_TIMEOUT_MS }),
      FUNCTION_TIMEOUT_MS + 1_000,
      'rendered Nadir rows'
    );

    const extractedRows = await withTimeout(
      page.$$eval('div.row.align-items-center', rows =>
        rows.map(row => ({
          label: row.querySelector('h5')?.textContent?.trim() || '',
          values: Array.from(row.querySelectorAll('.col-4.text-center'))
            .map(cell => (cell.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
        }))
      ),
      FUNCTION_TIMEOUT_MS,
      'DOM extraction'
    );

    return transformNadirRows(mapExtractedRows(extractedRows));
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function loadFromGoldApi() {
  const [goldPayload, silverPayload, fxPayload] = await Promise.all([
    fetchJson(GOLD_API_XAU_URL, FUNCTION_TIMEOUT_MS, 'Gold API XAU'),
    fetchJson(GOLD_API_XAG_URL, FUNCTION_TIMEOUT_MS, 'Gold API XAG'),
    fetchJson(FX_API_URL, FUNCTION_TIMEOUT_MS, 'FX API USD/EUR')
  ]);

  const baseRates = {
    goldOnsUsd: parseGoldApiPrice(goldPayload, 'XAU'),
    silvOnsUsd: parseGoldApiPrice(silverPayload, 'XAG'),
    usdToEur: parseFxUsdEur(fxPayload)
  };
  const rawRows = buildRawGoldApiRows(baseRates);
  const profile = calibrationState.profile
    || (calibrationState.lastNadirRows ? deriveCalibrationProfile(calibrationState.lastNadirRows, rawRows) : null);
  return buildGoldApiFallbackRows(baseRates, profile);
}

async function refreshCalibrationFromNadir(rows) {
  try {
    const [goldPayload, silverPayload, fxPayload] = await Promise.all([
      fetchJson(GOLD_API_XAU_URL, FUNCTION_TIMEOUT_MS, 'Gold API XAU calibration'),
      fetchJson(GOLD_API_XAG_URL, FUNCTION_TIMEOUT_MS, 'Gold API XAG calibration'),
      fetchJson(FX_API_URL, FUNCTION_TIMEOUT_MS, 'FX API USD/EUR calibration')
    ]);
    const rawRows = buildRawGoldApiRows({
      goldOnsUsd: parseGoldApiPrice(goldPayload, 'XAU'),
      silvOnsUsd: parseGoldApiPrice(silverPayload, 'XAG'),
      usdToEur: parseFxUsdEur(fxPayload)
    });
    calibrationState.profile = deriveCalibrationProfile(rows, rawRows);
    calibrationState.lastNadirRows = rows;
    calibrationState.updatedAt = new Date().toISOString();
  } catch {
    calibrationState.lastNadirRows = rows;
  }
}

module.exports = async function handler(req, res) {
  const nadirDisabled = isNadirDisabled();
  try {
    if (!nadirDisabled) {
      const rows = await loadFromBrowserless();
      await refreshCalibrationFromNadir(rows);
      writeSuccess(res, storeSuccess('nadirdoviz-browserless', rows));
      return;
    }
    throw new Error('Nadir is disabled.');
  } catch (browserlessError) {
    try {
      const rows = await loadFromGoldApi();
      writeSuccess(res, storeSuccess('goldapi-fallback', rows));
      return;
    } catch (goldApiError) {
      const stalePayload = getStalePayloadForMode(nadirDisabled);
      if (stalePayload) {
        writeSuccess(res, stalePayload);
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({
        ok: false,
        error: 'Failed to fetch prices.',
        details: `Browserless failed: ${String(browserlessError.message || browserlessError)}; Gold API failed: ${String(goldApiError.message || goldApiError)}`
      });
    }
  }
};
