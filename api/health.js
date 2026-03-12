const { TARGET_URL, GOLD_API_XAU_URL, GOLD_API_XAG_URL, FX_API_URL, getBrowserlessWsUrl, isNadirDisabled } = require('./_shared/prices');

module.exports = async function handler(req, res) {
  const wsUrl = getBrowserlessWsUrl();
  const nadirDisabled = isNadirDisabled();

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    provider: 'nadirdoviz-browserless',
    fallbackProvider: 'goldapi-fallback',
    nadirDisabled,
    targetUrl: TARGET_URL,
    browserlessConfigured: Boolean(wsUrl),
    browserlessEndpoint: wsUrl ? wsUrl.replace(/\?.*$/, '') : null,
    goldApiFallback: {
      xauUrl: GOLD_API_XAU_URL,
      xagUrl: GOLD_API_XAG_URL,
      fxUrl: FX_API_URL
    }
  });
};
