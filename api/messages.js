/**
 * Vercel serverless proxy: browser → same origin → Anthropic Messages API.
 * Anthropic does not send CORS headers; direct browser calls fail on production.
 *
 * Env (optional, recommended on Vercel): ANTHROPIC_API_KEY — server-only, not in the bundle.
 * If unset, forwards x-api-key from the client (same as REACT_APP_ANTHROPIC_API_KEY flow).
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function getJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body;
    if (typeof req.body === 'object') return JSON.stringify(req.body);
  }
  return readRawBody(req);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, x-api-key, anthropic-version'
    );
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const serverKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const headerKey = (req.headers['x-api-key'] || '').toString().trim();
  const apiKey = serverKey || headerKey;

  if (!apiKey) {
    return res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message:
          'Missing API key. Set ANTHROPIC_API_KEY on Vercel or send x-api-key.',
      },
    });
  }

  let body;
  try {
    body = await getJsonBody(req);
  } catch {
    return res.status(400).json({ error: { message: 'Invalid body' } });
  }

  if (!body) {
    return res.status(400).json({ error: { message: 'Empty body' } });
  }

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      },
      body,
    });

    const text = await r.text();
    const ct = r.headers.get('content-type') || 'application/json';
    res.status(r.status);
    res.setHeader('Content-Type', ct);
    res.send(text);
  } catch (err) {
    console.error('Anthropic proxy error', err);
    res.status(502).json({
      type: 'error',
      error: { message: 'Anthropic proxy failed' },
    });
  }
};
