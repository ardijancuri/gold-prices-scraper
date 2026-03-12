const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  GOLD_API_XAU_URL,
  GOLD_API_XAG_URL,
  FX_API_URL,
  transformNadirRows,
  buildRawGoldApiRows,
  deriveCalibrationProfile,
  buildGoldApiFallbackRows,
  parseGoldApiPrice,
  parseFxUsdEur,
  isNadirDisabled
} = require('./api/_shared/prices');

const PORT = Number(process.env.PORT || 3000);
const TARGET_URL = 'https://www.nadirdoviz.com/fiyat-ekrani';
const CACHE_TTL_MS = 18_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BROWSER_BOOT_TIMEOUT_MS = 25_000;
const RENDER_WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 400;
const REMOTE_DEBUGGING_PORT = Number(process.env.NADIR_DEBUG_PORT || 9420);
const BROWSER_MODE = process.env.NADIR_BROWSER_MODE || 'hidden';

const ROWS = {
  goldKgUsd: { label: 'AltinKG/USD', patterns: [/^a.+kg\/usd$/i] },
  goldKgEur: { label: 'AltinKG/EUR', patterns: [/^a.+kg\/eur$/i] },
  silvOns: { label: 'Gumus/ONS', patterns: [/^g.+\/ons$/i] },
  silvKgUsd: { label: 'GumusKG/USD', patterns: [/^g.+kg\/usd$/i] },
  silvKgEur: { label: 'GumusKG/EUR', patterns: [/^g.+kg\/eur$/i] }
};

const LABEL_KEYS = [
  'ad',
  'adi',
  'adTr',
  'adEn',
  'adTxt',
  'name',
  'title',
  'baslik',
  'kod',
  'kur',
  'kurAd',
  'kurAdi',
  'label',
  'metin'
];

const BUY_KEYS = ['alisEkran', 'alis', 'buy', 'buyPrice', 'buyValue', 'alisFiyat'];
const SELL_KEYS = ['satisEkran', 'satis', 'sell', 'sellPrice', 'sellValue', 'satisFiyat'];

const MOJIBAKE_REPLACEMENTS = [
  ['Ã„Â±', 'i'],
  ['Ã„Â°', 'I'],
  ['ÃƒÂ¼', 'u'],
  ['ÃƒÅ“', 'U'],
  ['Ã…Å¸', 's'],
  ['Ã…Å¾', 'S'],
  ['ÃƒÂ§', 'c'],
  ['Ãƒâ€¡', 'C'],
  ['Ã„Å¸', 'g'],
  ['Ã„Å¾', 'G'],
  ['ÃƒÂ¶', 'o'],
  ['Ãƒâ€“', 'O'],
  ['Ã¢â‚¬â„¢', "'"],
  ['`', "'"]
];

const cache = {
  value: null,
  fetchedAt: 0,
  expiresAt: 0,
  lastSuccessAt: 0,
  lastAttemptAt: 0,
  source: 'nadirdoviz-browser',
  lastError: null
};

const calibrationState = {
  profile: null,
  lastNadirRows: null,
  updatedAt: 0
};

const browserState = {
  process: null,
  ws: null,
  messageId: 0,
  pending: new Map(),
  browserPath: null,
  userDataDir: null,
  pageWebSocketUrl: null,
  targetId: null,
  ready: false,
  startedAt: 0,
  lastHealthyAt: 0,
  lastPhase: 'idle',
  lastRenderedSample: null
};

const transportState = {
  lastRequestAt: 0,
  lastResponseAt: 0,
  lastApiRequest: null,
  lastApiResponse: null,
  lastKurOkuRequest: null,
  lastKurOkuResponse: null,
  lastHubEvent: null,
  recent: [],
  bodies: new Map()
};

let inFlight = null;

function normalizeText(value) {
  let text = String(value || '');
  for (const [from, to] of MOJIBAKE_REPLACEMENTS) {
    text = text.split(from).join(to);
  }
  return text
    .replace(/Ä±/g, 'i')
    .replace(/Ä°/g, 'I')
    .replace(/ÅŸ/g, 's')
    .replace(/Åž/g, 'S')
    .replace(/Ã§/g, 'c')
    .replace(/Ã‡/g, 'C')
    .replace(/ÄŸ/g, 'g')
    .replace(/Äž/g, 'G')
    .replace(/Ã¶/g, 'o')
    .replace(/Ã–/g, 'O')
    .replace(/Ã¼/g, 'u')
    .replace(/Ãœ/g, 'U')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function matchesRowLabel(value, config) {
  const normalized = normalizeKey(value);
  return config.patterns.some(pattern => pattern.test(normalized));
}

function parseNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  const raw = String(value || '').trim().replace(/\s/g, '');
  if (!raw) {
    return NaN;
  }
  if (raw.includes('.') && raw.includes(',')) {
    const lastComma = raw.lastIndexOf(',');
    const lastDot = raw.lastIndexOf('.');
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    return Number(raw.replaceAll(thousandsSeparator, '').replace(decimalSeparator, '.'));
  }
  if (raw.includes(',')) {
    return Number(raw.replace(',', '.'));
  }
  return Number(raw);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|td|tr|table|li|ul|label|span|p|a|button|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '\n');
}

function parseRowsFromCardHtml(html) {
  const rows = {};
  const rowParts = String(html || '').split(/<div class="row align-items-center">/i).slice(1);

  for (const part of rowParts) {
    const rowHtml = part.split(/(?:<!--!-->\s*<hr|<hr)/i)[0];
    const labelMatch = rowHtml.match(/<h5[^>]*>\s*([^<]+?)\s*<\/h5>/i);
    if (!labelMatch) {
      continue;
    }

    const rowEntry = Object.entries(ROWS).find(([, config]) => matchesRowLabel(labelMatch[1], config));
    if (!rowEntry) {
      continue;
    }

    const rowText = htmlToText(rowHtml);
    const numberMatches = [...rowText.matchAll(/\d[\d.,]*/g)]
      .map(value => parseNumber(value[0]))
      .filter(Number.isFinite);

    if (numberMatches.length < 2) {
      continue;
    }

    rows[rowEntry[0]] = {
      label: rowEntry[1].label,
      buy: numberMatches[0],
      sell: numberMatches[1]
    };
  }

  for (const [key, config] of Object.entries(ROWS)) {
    if (!rows[key]) {
      throw new Error(`Missing scraped row: ${config.label}`);
    }
  }

  return rows;
}

function parseRowsFromText(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map(line => normalizeText(line))
    .filter(Boolean);

  const rows = {};
  for (let index = 0; index < lines.length; index += 1) {
    const rowEntry = Object.entries(ROWS).find(([, config]) => matchesRowLabel(lines[index], config));
    if (!rowEntry) {
      continue;
    }

    const numbers = [];
    for (let cursor = index + 1; cursor < lines.length && numbers.length < 2; cursor += 1) {
      const parsed = parseNumber(lines[cursor]);
      if (Number.isFinite(parsed)) {
        numbers.push(parsed);
      }
    }

    if (numbers.length === 2) {
      rows[rowEntry[0]] = {
        label: rowEntry[1].label,
        buy: numbers[0],
        sell: numbers[1]
      };
    }
  }

  for (const [key, config] of Object.entries(ROWS)) {
    if (!rows[key]) {
      throw new Error(`Missing scraped row: ${config.label}`);
    }
  }

  return rows;
}

function parseRowsFromCompactText(text) {
  const compact = normalizeText(text);
  const rows = {};

  for (const [key, config] of Object.entries(ROWS)) {
    const labelPattern = config.patterns
      .map(pattern => pattern.source.replace(/^\^|\$$/g, ''))
      .join('|');
    const match = compact.match(new RegExp(`(?:${labelPattern})\\s*([\\d.,]+)\\s*([\\d.,]+)`, 'i'));
    if (!match) {
      throw new Error(`Missing scraped row: ${config.label}`);
    }

    const buy = parseNumber(match[1]);
    const sell = parseNumber(match[2]);
    if (!Number.isFinite(buy) || !Number.isFinite(sell)) {
      throw new Error(`Invalid numeric values for: ${config.label}`);
    }

    rows[key] = {
      label: config.label,
      buy,
      sell
    };
  }

  return rows;
}

function parseRowsFromHtml(html) {
  try {
    return parseRowsFromCardHtml(html);
  } catch {
    const text = htmlToText(html);
    try {
      return parseRowsFromText(text);
    } catch {
      return parseRowsFromCompactText(text);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function pickEnvPath(name) {
  const value = process.env[name];
  return value && fs.existsSync(value) ? value : null;
}

function findBrowserPath() {
  const candidates = [
    pickEnvPath('NADIR_EDGE_PATH'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];

  return candidates.find(Boolean) || null;
}

function resetTransportState() {
  transportState.lastRequestAt = 0;
  transportState.lastResponseAt = 0;
  transportState.lastApiRequest = null;
  transportState.lastApiResponse = null;
  transportState.lastKurOkuRequest = null;
  transportState.lastKurOkuResponse = null;
  transportState.lastHubEvent = null;
  transportState.recent = [];
  transportState.bodies = new Map();
}

function resetBrowserState() {
  browserState.ready = false;
  browserState.pageWebSocketUrl = null;
  browserState.targetId = null;
  browserState.lastRenderedSample = null;
  browserState.lastPhase = 'idle';
  if (browserState.ws) {
    try {
      browserState.ws.close();
    } catch {}
  }
  browserState.ws = null;
  for (const pending of browserState.pending.values()) {
    pending.reject(new Error('Browser session was reset.'));
  }
  browserState.pending.clear();
  browserState.messageId = 0;
  resetTransportState();
}

function appendTransportEvent(event) {
  transportState.recent.push({
    time: new Date().toISOString(),
    ...event
  });
  if (transportState.recent.length > 30) {
    transportState.recent.shift();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) {
    throw new Error(`DevTools request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchExternalJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDevToolsList() {
  return waitFor(async () => {
    try {
      return await fetchJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/list`);
    } catch {
      return null;
    }
  }, BROWSER_BOOT_TIMEOUT_MS, 'DevTools endpoint');
}

async function launchBrowserProcess() {
  if (browserState.process && browserState.process.exitCode === null) {
    return;
  }

  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error('Could not find Edge or Chrome on this machine.');
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argjira-nadir-'));
  const args = [
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1400,1200'
  ];

  if (BROWSER_MODE === 'headless') {
    args.push('--headless=new');
  } else {
    args.push('--window-position=-32000,-32000');
  }

  args.push(TARGET_URL);

  const child = spawn(browserPath, args, {
    stdio: 'ignore',
    windowsHide: true
  });

  child.once('exit', () => {
    resetBrowserState();
    browserState.process = null;
  });

  browserState.browserPath = browserPath;
  browserState.userDataDir = userDataDir;
  browserState.process = child;
  browserState.startedAt = Date.now();
  browserState.lastPhase = 'launch';
}

async function getPageTarget() {
  const list = await waitForDevToolsList();
  const target = list.find(item => item.type === 'page' && item.url && item.url.includes('nadirdoviz.com'))
    || list.find(item => item.type === 'page');

  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error('Could not find a browser page target.');
  }
  return target;
}

function startSocketHeartbeat() {
  const ws = browserState.ws;
  if (!ws) {
    return;
  }
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ id: ++browserState.messageId, method: 'Runtime.evaluate', params: { expression: '1' } }));
      } catch {}
    }
  }, 20_000);
  ws.addEventListener('close', () => clearInterval(timer), { once: true });
}

function handleNetworkRequest(params) {
  const request = params.request || {};
  const url = String(request.url || '');
  const tracked = url.includes('/api/') || url.includes('hub') || url.includes('negotiate');
  if (!tracked) {
    return;
  }

  const snapshot = {
    requestId: params.requestId,
    url,
    method: request.method || 'GET',
    headers: request.headers || {},
    postData: request.postData || null
  };
  transportState.lastRequestAt = Date.now();
  transportState.lastApiRequest = snapshot;
  transportState.bodies.set(params.requestId, snapshot);
  appendTransportEvent({
    kind: 'request',
    method: snapshot.method,
    url
  });

  if (url.includes('/api/KurOku')) {
    transportState.lastKurOkuRequest = snapshot;
  }
}

function handleNetworkResponse(params) {
  const response = params.response || {};
  const url = String(response.url || '');
  const tracked = url.includes('/api/') || url.includes('hub') || url.includes('negotiate');
  if (!tracked) {
    return;
  }

  const prior = transportState.bodies.get(params.requestId) || { requestId: params.requestId, url };
  prior.status = response.status;
  prior.mimeType = response.mimeType || null;
  prior.responseHeaders = response.headers || {};
  transportState.bodies.set(params.requestId, prior);
  appendTransportEvent({
    kind: 'response',
    status: response.status,
    url
  });
}

function handleWebSocketFrame(params) {
  const payload = String(params.response?.payloadData || '');
  if (!payload) {
    return;
  }
  transportState.lastHubEvent = {
    opcode: params.response?.opcode || null,
    payloadSample: payload.slice(0, 600)
  };
  appendTransportEvent({
    kind: 'ws',
    sample: payload.slice(0, 120)
  });
}

function handleBrowserEvent(message) {
  const { method, params } = message;
  if (method === 'Network.requestWillBeSent') {
    handleNetworkRequest(params);
    return;
  }
  if (method === 'Network.responseReceived') {
    handleNetworkResponse(params);
    return;
  }
  if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
    handleWebSocketFrame(params);
    return;
  }
  if (method === 'Network.loadingFinished') {
    finalizeTrackedResponse(params.requestId).catch(() => {});
    return;
  }
  if (method === 'Inspector.targetCrashed') {
    cache.lastError = 'Hidden browser target crashed.';
  }
}

async function connectToPageTarget(target) {
  resetBrowserState();
  browserState.pageWebSocketUrl = target.webSocketDebuggerUrl;
  browserState.targetId = target.id;
  browserState.lastPhase = 'connect';

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  browserState.ws = ws;

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = error => {
      ws.removeEventListener('open', onOpen);
      reject(error);
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });

  ws.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = browserState.pending.get(message.id);
      if (!pending) {
        return;
      }
      browserState.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'CDP error'));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    handleBrowserEvent(message);
  });

  ws.addEventListener('close', () => {
    resetBrowserState();
  }, { once: true });

  startSocketHeartbeat();
}

function cdpSend(method, params = {}) {
  const ws = browserState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Browser DevTools socket is not connected.');
  }
  const id = ++browserState.messageId;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    browserState.pending.set(id, { resolve, reject });
    try {
      ws.send(payload);
    } catch (error) {
      browserState.pending.delete(id);
      reject(error);
    }
  });
}

async function finalizeTrackedResponse(requestId) {
  const tracked = transportState.bodies.get(requestId);
  if (!tracked || tracked.bodyFetched || !(tracked.url || '').includes('/api/')) {
    return;
  }
  tracked.bodyFetched = true;
  try {
    const bodyRes = await cdpSend('Network.getResponseBody', { requestId });
    tracked.body = bodyRes.body || '';
    tracked.base64Encoded = Boolean(bodyRes.base64Encoded);
    tracked.fetchedAt = Date.now();
    transportState.lastResponseAt = tracked.fetchedAt;
    transportState.lastApiResponse = tracked;
    if ((tracked.url || '').includes('/api/KurOku')) {
      transportState.lastKurOkuResponse = tracked;
    }
  } catch (error) {
    tracked.bodyError = String(error.message || error);
  }
}

async function enablePageInstrumentation() {
  await cdpSend('Page.enable');
  await cdpSend('Runtime.enable');
  await cdpSend('Network.enable', {
    maxTotalBufferSize: 10_000_000,
    maxResourceBufferSize: 2_000_000,
    maxPostDataSize: 250_000
  });
  browserState.lastPhase = 'instrumented';
}

async function ensureBrowserSession({ forceReload = false } = {}) {
  let didInitialConnect = false;
  if (!browserState.ready) {
    await launchBrowserProcess();
    const target = await getPageTarget();
    await connectToPageTarget(target);
    await enablePageInstrumentation();
    browserState.ready = true;
    didInitialConnect = true;
  }

  browserState.lastPhase = 'navigate';
  if (forceReload || didInitialConnect || !transportState.lastApiRequest) {
    resetTransportState();
    await cdpSend('Page.reload', { ignoreCache: true });
  }

  await waitForRenderedRows();
  browserState.lastHealthyAt = Date.now();
}

async function getRenderedSnapshot() {
  const [htmlResult, textResult] = await Promise.all([
    cdpSend('Runtime.evaluate', {
      expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue: true,
      awaitPromise: true
    }),
    cdpSend('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
      awaitPromise: true
    })
  ]);

  return {
    html: String(htmlResult.result?.value || ''),
    text: String(textResult.result?.value || '')
  };
}

function renderedRowsVisible(text) {
  const normalized = normalizeKey(text);
  return normalized.includes('altinkg/usd') || normalized.includes('gumuskg/eur');
}

async function waitForRenderedRows() {
  browserState.lastPhase = 'render';
  return waitFor(async () => {
    const snapshot = await getRenderedSnapshot();
    browserState.lastRenderedSample = snapshot.text.slice(0, 1200);
    if (renderedRowsVisible(snapshot.text)) {
      return snapshot;
    }
    return null;
  }, RENDER_WAIT_TIMEOUT_MS, 'rendered Nadir price rows');
}

function tryJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findRowsInValue(value, results, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  const labelValue = LABEL_KEYS
    .map(key => value[key])
    .find(item => typeof item === 'string' && item.trim());

  if (labelValue) {
    const rowEntry = Object.entries(ROWS).find(([, config]) => matchesRowLabel(labelValue, config));
    if (rowEntry) {
      const buyValue = BUY_KEYS.map(key => value[key]).find(item => Number.isFinite(parseNumber(item)));
      const sellValue = SELL_KEYS.map(key => value[key]).find(item => Number.isFinite(parseNumber(item)));
      const buy = parseNumber(buyValue);
      const sell = parseNumber(sellValue);
      if (Number.isFinite(buy) && Number.isFinite(sell)) {
        results[rowEntry[0]] = {
          label: rowEntry[1].label,
          buy,
          sell
        };
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findRowsInValue(item, results, seen);
    }
    return;
  }

  for (const item of Object.values(value)) {
    findRowsInValue(item, results, seen);
  }
}

function validateRows(rows) {
  for (const [key, config] of Object.entries(ROWS)) {
    if (!rows[key] || !Number.isFinite(rows[key].buy) || !Number.isFinite(rows[key].sell)) {
      throw new Error(`Missing scraped row: ${config.label}`);
    }
  }
  return rows;
}

function parseRowsFromApiPayload(payload) {
  const rows = {};
  findRowsInValue(payload, rows, new Set());
  return validateRows(rows);
}

function parseRowsFromTransportBody(body) {
  const payload = tryJsonParse(body);
  if (!payload) {
    throw new Error('Transport body is not valid JSON.');
  }
  return parseRowsFromApiPayload(payload);
}

async function getRowsFromInternalFeed() {
  const response = transportState.lastKurOkuResponse || transportState.lastApiResponse;
  if (!response?.body) {
    return null;
  }
  const rows = parseRowsFromTransportBody(response.body);
  return {
    source: 'nadirdoviz-internal',
    rows
  };
}

async function getRowsFromRenderedDom() {
  const snapshot = await getRenderedSnapshot();
  browserState.lastRenderedSample = snapshot.text.slice(0, 1200);
  const rows = transformNadirRows(parseRowsFromHtml(snapshot.html));
  return {
    source: 'nadirdoviz-dom',
    rows,
    snapshot
  };
}

async function getRowsFromGoldApiFallback() {
  const [goldPayload, silverPayload, fxPayload] = await Promise.all([
    fetchExternalJson(GOLD_API_XAU_URL, 'Gold API XAU'),
    fetchExternalJson(GOLD_API_XAG_URL, 'Gold API XAG'),
    fetchExternalJson(FX_API_URL, 'FX API USD/EUR')
  ]);

  const baseRates = {
    goldOnsUsd: parseGoldApiPrice(goldPayload, 'XAU'),
    silvOnsUsd: parseGoldApiPrice(silverPayload, 'XAG'),
    usdToEur: parseFxUsdEur(fxPayload)
  };
  const rawRows = buildRawGoldApiRows(baseRates);
  const profile = calibrationState.profile
    || (calibrationState.lastNadirRows ? deriveCalibrationProfile(calibrationState.lastNadirRows, rawRows) : null);

  return {
    source: 'goldapi-fallback',
    rows: buildGoldApiFallbackRows(baseRates, profile)
  };
}

async function refreshCalibrationFromNadir(rows) {
  try {
    const [goldPayload, silverPayload, fxPayload] = await Promise.all([
      fetchExternalJson(GOLD_API_XAU_URL, 'Gold API XAU calibration'),
      fetchExternalJson(GOLD_API_XAG_URL, 'Gold API XAG calibration'),
      fetchExternalJson(FX_API_URL, 'FX API USD/EUR calibration')
    ]);
    const rawRows = buildRawGoldApiRows({
      goldOnsUsd: parseGoldApiPrice(goldPayload, 'XAU'),
      silvOnsUsd: parseGoldApiPrice(silverPayload, 'XAG'),
      usdToEur: parseFxUsdEur(fxPayload)
    });
    calibrationState.profile = deriveCalibrationProfile(rows, rawRows);
    calibrationState.lastNadirRows = rows;
    calibrationState.updatedAt = Date.now();
  } catch {
    calibrationState.lastNadirRows = rows;
  }
}

async function collectLiveRows() {
  await ensureBrowserSession();

  try {
    await getRowsFromInternalFeed();
  } catch (error) {
    appendTransportEvent({
      kind: 'parse-error',
      source: 'internal',
      message: String(error.message || error)
    });
  }

  browserState.lastPhase = 'dom-live';
  return getRowsFromRenderedDom();
}

function hasCache() {
  return Boolean(cache.value);
}

function isCacheFresh() {
  return hasCache() && cache.expiresAt > Date.now();
}

function canUseFreshCache() {
  if (!isCacheFresh()) {
    return false;
  }
  if (isNadirDisabled() && cache.source !== 'goldapi-fallback') {
    return false;
  }
  return true;
}

function buildPayload({ cached, stale }) {
  return {
    provider: cache.source,
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    lastSuccessAt: cache.lastSuccessAt ? new Date(cache.lastSuccessAt).toISOString() : null,
    cached,
    stale,
    rows: cache.value
  };
}

async function getPrices() {
  if (canUseFreshCache()) {
    return buildPayload({ cached: true, stale: false });
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    cache.lastAttemptAt = Date.now();
    const nadirDisabled = isNadirDisabled();
    try {
      const result = nadirDisabled
        ? await getRowsFromGoldApiFallback()
        : await collectLiveRows();
      if (!nadirDisabled) {
        await refreshCalibrationFromNadir(result.rows);
      }
      cache.value = result.rows;
      cache.fetchedAt = Date.now();
      cache.expiresAt = cache.fetchedAt + CACHE_TTL_MS;
      cache.lastSuccessAt = cache.fetchedAt;
      cache.source = result.source;
      cache.lastError = null;
      return buildPayload({ cached: false, stale: false });
    } catch (error) {
      if (nadirDisabled) {
        cache.lastError = `Gold API failed: ${String(error.message || error)}`;
        if (hasCache() && cache.source === 'goldapi-fallback') {
          return buildPayload({ cached: true, stale: true });
        }
        throw error;
      }

      cache.lastError = `Nadir failed: ${String(error.message || error)}`;
      try {
        await ensureBrowserSession({ forceReload: true });
        const retryResult = await collectLiveRows();
        cache.value = retryResult.rows;
        cache.fetchedAt = Date.now();
        cache.expiresAt = cache.fetchedAt + CACHE_TTL_MS;
        cache.lastSuccessAt = cache.fetchedAt;
        cache.source = retryResult.source;
        cache.lastError = null;
        return buildPayload({ cached: false, stale: false });
      } catch (retryError) {
        const retryMessage = String(retryError.message || retryError);
        try {
          const fallbackResult = await getRowsFromGoldApiFallback();
          cache.value = fallbackResult.rows;
          cache.fetchedAt = Date.now();
          cache.expiresAt = cache.fetchedAt + CACHE_TTL_MS;
          cache.lastSuccessAt = cache.fetchedAt;
          cache.source = fallbackResult.source;
          cache.lastError = `Nadir failed: ${retryMessage}`;
          return buildPayload({ cached: false, stale: false });
        } catch (fallbackError) {
          cache.lastError = `Nadir failed: ${retryMessage}; Gold API failed: ${String(fallbackError.message || fallbackError)}`;
          if (hasCache()) {
            return buildPayload({ cached: true, stale: true });
          }
          throw fallbackError;
        }
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function transportSummary() {
  return {
    lastRequestAt: transportState.lastRequestAt ? new Date(transportState.lastRequestAt).toISOString() : null,
    lastResponseAt: transportState.lastResponseAt ? new Date(transportState.lastResponseAt).toISOString() : null,
    lastApiRequest: transportState.lastApiRequest ? {
      url: transportState.lastApiRequest.url,
      method: transportState.lastApiRequest.method
    } : null,
    lastApiResponse: transportState.lastApiResponse ? {
      url: transportState.lastApiResponse.url,
      status: transportState.lastApiResponse.status,
      bodySample: String(transportState.lastApiResponse.body || '').slice(0, 600)
    } : null,
    lastKurOkuRequest: transportState.lastKurOkuRequest ? {
      url: transportState.lastKurOkuRequest.url,
      method: transportState.lastKurOkuRequest.method,
      postData: transportState.lastKurOkuRequest.postData || null
    } : null,
    lastKurOkuResponse: transportState.lastKurOkuResponse ? {
      url: transportState.lastKurOkuResponse.url,
      status: transportState.lastKurOkuResponse.status,
      bodySample: String(transportState.lastKurOkuResponse.body || '').slice(0, 600)
    } : null,
    lastHubEvent: transportState.lastHubEvent,
    recent: transportState.recent
  };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function requestListener(request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    writeJson(response, 200, {
      ok: true,
      service: 'argjira-prices-api',
      provider: cache.source,
      fallbackProvider: 'goldapi-fallback',
      nadirDisabled: isNadirDisabled(),
      targetUrl: TARGET_URL,
      goldApiFallback: {
        xauUrl: GOLD_API_XAU_URL,
        xagUrl: GOLD_API_XAG_URL,
        fxUrl: FX_API_URL
      },
      calibration: {
        learned: Boolean(calibrationState.profile),
        updatedAt: calibrationState.updatedAt ? new Date(calibrationState.updatedAt).toISOString() : null
      },
      browserPath: browserState.browserPath,
      browser: {
        mode: BROWSER_MODE,
        ready: browserState.ready,
        startedAt: browserState.startedAt ? new Date(browserState.startedAt).toISOString() : null,
        lastHealthyAt: browserState.lastHealthyAt ? new Date(browserState.lastHealthyAt).toISOString() : null,
        debugPort: REMOTE_DEBUGGING_PORT,
        phase: browserState.lastPhase
      },
      cache: {
        hasData: hasCache(),
        fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
        expiresAt: cache.expiresAt ? new Date(cache.expiresAt).toISOString() : null,
        lastSuccessAt: cache.lastSuccessAt ? new Date(cache.lastSuccessAt).toISOString() : null,
        lastAttemptAt: cache.lastAttemptAt ? new Date(cache.lastAttemptAt).toISOString() : null
      },
      transport: transportSummary(),
      inFlight: Boolean(inFlight),
      lastRenderedSample: browserState.lastRenderedSample,
      lastError: cache.lastError
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/debug-html') {
    try {
      await ensureBrowserSession();
      const snapshot = await getRenderedSnapshot();
      browserState.lastRenderedSample = snapshot.text.slice(0, 1200);
      writeJson(response, 200, {
        ok: true,
        provider: cache.source,
        targetUrl: TARGET_URL,
        transport: transportSummary(),
        debug: {
          htmlLength: snapshot.html.length,
          textLength: snapshot.text.length,
          htmlSample: snapshot.html.slice(0, 2500),
          textSample: snapshot.text.slice(0, 2500)
        }
      });
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: 'Failed to capture rendered HTML.',
        details: String(error.message || error)
      });
    }
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/prices') {
    try {
      const payload = await getPrices();
      writeJson(response, 200, payload);
    } catch (error) {
      writeJson(response, 503, {
        ok: false,
        error: 'Failed to fetch prices.',
        details: String(error.message || error)
      });
    }
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: 'Not found.'
  });
}

function cleanupBrowserArtifacts() {
  if (browserState.process && browserState.process.exitCode === null) {
    try {
      browserState.process.kill();
    } catch {}
  }
  if (browserState.userDataDir) {
    try {
      fs.rmSync(browserState.userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

function attachProcessCleanup() {
  const clean = () => cleanupBrowserArtifacts();
  process.once('exit', clean);
  process.once('SIGINT', () => {
    clean();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    clean();
    process.exit(143);
  });
}

function startServer(port = PORT) {
  attachProcessCleanup();

  const server = http.createServer((request, response) => {
    requestListener(request, response).catch(error => {
      writeJson(response, 500, {
        ok: false,
        error: 'Unexpected server error.',
        details: String(error.message || error)
      });
    });
  });

  server.listen(port, () => {
    console.log(`Argjira API listening on http://localhost:${port}`);
    if (!isNadirDisabled()) {
      getPrices().catch(() => {});
    }
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  ROWS,
  cache,
  browserState,
  transportState,
  cleanupBrowserArtifacts,
  normalizeText,
  normalizeKey,
  parseNumber,
  htmlToText,
  parseRowsFromCardHtml,
  parseRowsFromText,
  parseRowsFromCompactText,
  parseRowsFromHtml,
  parseRowsFromApiPayload,
  parseRowsFromTransportBody,
  getRowsFromInternalFeed,
  getRowsFromRenderedDom,
  getPrices,
  startServer
};
