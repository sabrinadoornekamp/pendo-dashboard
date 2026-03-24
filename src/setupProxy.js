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
};
