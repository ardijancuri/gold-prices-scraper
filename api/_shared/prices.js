const TARGET_URL = 'https://www.nadirdoviz.com/fiyat-ekrani';
const GOLD_API_XAU_URL = 'https://api.gold-api.com/price/XAU';
const GOLD_API_XAG_URL = 'https://api.gold-api.com/price/XAG';
const FX_API_URL = 'https://open.er-api.com/v6/latest/USD';
const OUNCE_TO_KG = 32.151;

const SCRAPED_ROWS = {
  goldKgUsd: { label: 'AltinKG/USD', patterns: [/^a.+kg\/usd$/i] },
  goldKgEur: { label: 'AltinKG/EUR', patterns: [/^a.+kg\/eur$/i] },
  silvOns: { label: 'Gumus/ONS', patterns: [/^g.+\/ons$/i] },
  silvKgUsd: { label: 'GumusKG/USD', patterns: [/^g.+kg\/usd$/i] },
  silvKgEur: { label: 'GumusKG/EUR', patterns: [/^g.+kg\/eur$/i] }
};

const DISPLAY_ROWS = {
  goldKgUsd: { label: 'AltinKG/USD' },
  goldKgEur: { label: 'AltinKG/EUR' },
  goldOnsUsd: { label: 'AltinONS/USD' },
  goldOnsEur: { label: 'AltinONS/EUR' },
  silvKgEur: { label: 'GumusKG/EUR' }
};

const CALIBRATION = {
  goldKgUsd: {
    buyFactor: Number(process.env.GOLDAPI_GOLD_KG_USD_BUY_FACTOR || 1.00035),
    sellFactor: Number(process.env.GOLDAPI_GOLD_KG_USD_SELL_FACTOR || 1.00405)
  },
  goldKgEur: {
    buyFactor: Number(process.env.GOLDAPI_GOLD_KG_EUR_BUY_FACTOR || 1.0053),
    sellFactor: Number(process.env.GOLDAPI_GOLD_KG_EUR_SELL_FACTOR || 1.0113)
  },
  goldOnsUsd: {
    buyFactor: Number(process.env.GOLDAPI_GOLD_ONS_USD_BUY_FACTOR || 1.00055),
    sellFactor: Number(process.env.GOLDAPI_GOLD_ONS_USD_SELL_FACTOR || 1.00425)
  },
  goldOnsEur: {
    buyFactor: Number(process.env.GOLDAPI_GOLD_ONS_EUR_BUY_FACTOR || 1.0055),
    sellFactor: Number(process.env.GOLDAPI_GOLD_ONS_EUR_SELL_FACTOR || 1.0115)
  },
  silvKgEur: {
    buyFactor: Number(process.env.GOLDAPI_SILVER_KG_EUR_BUY_FACTOR || 0.9905),
    sellFactor: Number(process.env.GOLDAPI_SILVER_KG_EUR_SELL_FACTOR || 1.0858)
  }
};

const MOJIBAKE_REPLACEMENTS = [
  ['ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â±', 'i'],
  ['ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°', 'I'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¼', 'u'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ', 'U'],
  ['ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸', 's'],
  ['ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾', 'S'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§', 'c'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¡', 'C'],
  ['ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸', 'g'],
  ['ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾', 'G'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¶', 'o'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ', 'O'],
  ['ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢', "'"],
  ['`', "'"]
];

function normalizeText(value) {
  let text = String(value || '');
  for (const [from, to] of MOJIBAKE_REPLACEMENTS) {
    text = text.split(from).join(to);
  }
  return text
    .replace(/ÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€šÃ‚Â±/g, 'i')
    .replace(/ÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€šÃ‚Â°/g, 'I')
    .replace(/ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€¦Ã‚Â¸/g, 's')
    .replace(/ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€¦Ã‚Â¾/g, 'S')
    .replace(/ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§/g, 'c')
    .replace(/ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡/g, 'C')
    .replace(/ÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€¦Ã‚Â¸/g, 'g')
    .replace(/ÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€¦Ã‚Â¾/g, 'G')
    .replace(/ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¶/g, 'o')
    .replace(/ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“/g, 'O')
    .replace(/ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¼/g, 'u')
    .replace(/ÃƒÆ’Ã†â€™Ãƒâ€¦Ã¢â‚¬Å“/g, 'U')
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

function extractNumericValues(values) {
  return (values || [])
    .map(text => {
      const match = String(text || '').match(/\d[\d.,]*/);
      return match ? parseNumber(match[0]) : NaN;
    })
    .filter(Number.isFinite);
}

function mapExtractedRows(extractedRows) {
  const rows = {};

  for (const entry of extractedRows || []) {
    const rowEntry = Object.entries(SCRAPED_ROWS).find(([, config]) => matchesRowLabel(entry.label, config));
    if (!rowEntry) {
      continue;
    }

    const numbers = extractNumericValues(entry.values);
    if (numbers.length < 2) {
      continue;
    }

    rows[rowEntry[0]] = {
      label: rowEntry[1].label,
      buy: numbers[0],
      sell: numbers[1]
    };
  }

  for (const [key, config] of Object.entries(SCRAPED_ROWS)) {
    if (!rows[key]) {
      throw new Error(`Missing scraped row: ${config.label}`);
    }
  }

  return rows;
}

function ensureFiniteRow(row, label) {
  const buy = Number(row?.buy);
  const sell = Number(row?.sell);
  if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0 || buy > sell) {
    throw new Error(`Invalid row: ${label}`);
  }
  return { label, buy, sell };
}

function transformNadirRows(rawRows) {
  const goldKgUsd = ensureFiniteRow(rawRows?.goldKgUsd, DISPLAY_ROWS.goldKgUsd.label);
  const goldKgEur = ensureFiniteRow(rawRows?.goldKgEur, DISPLAY_ROWS.goldKgEur.label);
  const silvKgEur = ensureFiniteRow(rawRows?.silvKgEur, DISPLAY_ROWS.silvKgEur.label);

  return {
    goldKgUsd,
    goldKgEur,
    goldOnsUsd: ensureFiniteRow({
      buy: goldKgUsd.buy / OUNCE_TO_KG,
      sell: goldKgUsd.sell / OUNCE_TO_KG
    }, DISPLAY_ROWS.goldOnsUsd.label),
    goldOnsEur: ensureFiniteRow({
      buy: goldKgEur.buy / OUNCE_TO_KG,
      sell: goldKgEur.sell / OUNCE_TO_KG
    }, DISPLAY_ROWS.goldOnsEur.label),
    silvKgEur
  };
}

function parseGoldApiPrice(payload, symbol) {
  const amount = parseNumber(payload?.price ?? payload?.price_gram_24k ?? payload?.data?.price);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid Gold API response for ${symbol}`);
  }
  return amount;
}

function parseFxUsdEur(payload) {
  const amount = parseNumber(payload?.rates?.EUR ?? payload?.conversion_rates?.EUR ?? payload?.data?.EUR);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid FX API response for USD/EUR');
  }
  return amount;
}

function clampFactor(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(1.2, Math.max(0.85, number));
}

function getDefaultCalibrationProfile() {
  return {
    goldKgUsd: { ...CALIBRATION.goldKgUsd },
    goldKgEur: { ...CALIBRATION.goldKgEur },
    goldOnsUsd: { ...CALIBRATION.goldOnsUsd },
    goldOnsEur: { ...CALIBRATION.goldOnsEur },
    silvKgEur: { ...CALIBRATION.silvKgEur }
  };
}

function buildRawGoldApiRows(baseRates) {
  const goldOnsUsdMid = Number(baseRates.goldOnsUsd);
  const goldOnsEurMid = goldOnsUsdMid * Number(baseRates.usdToEur);
  const goldKgUsdMid = goldOnsUsdMid * OUNCE_TO_KG;
  const goldKgEurMid = goldOnsEurMid * OUNCE_TO_KG;
  const silvKgEurMid = Number(baseRates.silvOnsUsd) * Number(baseRates.usdToEur) * OUNCE_TO_KG;

  return {
    goldKgUsd: ensureFiniteRow({ buy: goldKgUsdMid, sell: goldKgUsdMid }, DISPLAY_ROWS.goldKgUsd.label),
    goldKgEur: ensureFiniteRow({ buy: goldKgEurMid, sell: goldKgEurMid }, DISPLAY_ROWS.goldKgEur.label),
    goldOnsUsd: ensureFiniteRow({ buy: goldOnsUsdMid, sell: goldOnsUsdMid }, DISPLAY_ROWS.goldOnsUsd.label),
    goldOnsEur: ensureFiniteRow({ buy: goldOnsEurMid, sell: goldOnsEurMid }, DISPLAY_ROWS.goldOnsEur.label),
    silvKgEur: ensureFiniteRow({ buy: silvKgEurMid, sell: silvKgEurMid }, DISPLAY_ROWS.silvKgEur.label)
  };
}

function deriveCalibrationProfile(referenceRows, rawRows) {
  const defaults = getDefaultCalibrationProfile();
  const profile = {};

  for (const key of Object.keys(DISPLAY_ROWS)) {
    const reference = referenceRows?.[key];
    const raw = rawRows?.[key];
    if (!reference || !raw || !Number.isFinite(reference.buy) || !Number.isFinite(reference.sell) || !Number.isFinite(raw.buy) || !Number.isFinite(raw.sell) || raw.buy <= 0 || raw.sell <= 0) {
      profile[key] = defaults[key];
      continue;
    }

    let buyFactor = clampFactor(reference.buy / raw.buy, defaults[key].buyFactor);
    let sellFactor = clampFactor(reference.sell / raw.sell, defaults[key].sellFactor);
    if (buyFactor >= sellFactor) {
      sellFactor = Math.min(1.2, buyFactor + 0.0025);
    }
    profile[key] = { buyFactor, sellFactor };
  }

  return profile;
}

function applyCalibrationProfile(rawRows, profile = getDefaultCalibrationProfile()) {
  const defaults = getDefaultCalibrationProfile();
  const rows = {};

  for (const [key, config] of Object.entries(DISPLAY_ROWS)) {
    const raw = rawRows?.[key];
    const source = profile?.[key] || defaults[key];
    const buyFactor = clampFactor(source.buyFactor, defaults[key].buyFactor);
    const sellFactor = clampFactor(source.sellFactor, defaults[key].sellFactor);
    let buy = Number(raw?.buy) * buyFactor;
    let sell = Number(raw?.sell) * sellFactor;
    if (buy >= sell) {
      sell = buy * 1.0005;
    }
    rows[key] = ensureFiniteRow({ buy, sell }, config.label);
  }

  return rows;
}

function buildGoldApiFallbackRows(baseRates, calibrationProfile) {
  const rawRows = buildRawGoldApiRows(baseRates);
  return applyCalibrationProfile(rawRows, calibrationProfile || getDefaultCalibrationProfile());
}

function getBrowserlessWsUrl() {
  const directUrl = String(process.env.BROWSERLESS_WS_URL || '').trim();
  if (directUrl) {
    return directUrl;
  }

  const token = String(process.env.BROWSERLESS_TOKEN || '').trim();
  if (!token) {
    return null;
  }

  const baseUrl = String(process.env.BROWSERLESS_BASE_URL || 'wss://production-sfo.browserless.io').trim().replace(/\/$/, '');
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

function isNadirDisabled() {
  const value = String(process.env.NADIR_DISABLED || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  TARGET_URL,
  GOLD_API_XAU_URL,
  GOLD_API_XAG_URL,
  FX_API_URL,
  OUNCE_TO_KG,
  SCRAPED_ROWS,
  DISPLAY_ROWS,
  CALIBRATION,
  normalizeText,
  normalizeKey,
  parseNumber,
  parseGoldApiPrice,
  parseFxUsdEur,
  mapExtractedRows,
  transformNadirRows,
  buildRawGoldApiRows,
  deriveCalibrationProfile,
  applyCalibrationProfile,
  buildGoldApiFallbackRows,
  getBrowserlessWsUrl,
  isNadirDisabled,
  withTimeout
};
