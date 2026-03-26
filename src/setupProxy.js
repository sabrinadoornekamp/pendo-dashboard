const { createProxyMiddleware } = require('http-proxy-middleware');

/**
 * Stuurt /v1/* (o.a. POST /v1/messages) door naar Anthropic.
 * changeOrigin + secure voorkomen vaak 502/520 ten opzichte van de simpele "proxy" in package.json.
 */
module.exports = function setupProxy(app) {
  app.use(
    '/v1',
    createProxyMiddleware({
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      secure: true,
      timeout: 120000,
      proxyTimeout: 120000,
    })
  );

  // Pendo EU API: browser → same origin in dev (Pendo stuurt geen CORS voor localhost).
  app.use(
    '/pendo-api',
    createProxyMiddleware({
      target: 'https://app.eu.pendo.io',
      changeOrigin: true,
      secure: true,
      pathRewrite: { '^/pendo-api': '/api/v1' },
      timeout: 60000,
      proxyTimeout: 60000,
    })
  );

  // Pendo scoped API (zoals /api/s/<subscriptionId>/report in de UI).
  app.use(
    '/pendo-api-s',
    createProxyMiddleware({
      target: 'https://app.eu.pendo.io',
      changeOrigin: true,
      secure: true,
      pathRewrite: { '^/pendo-api-s': '/api/s' },
      timeout: 60000,
      proxyTimeout: 60000,
    })
  );
};
