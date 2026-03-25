const PENDO_BASE_URL_PROD = 'https://app.eu.pendo.io/api/v1';

export function getPendoApiRoot() {
  const override = (process.env.REACT_APP_PENDO_API_URL || '').trim();
  if (override) return override.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'development') {
    return '/pendo-api';
  }
  return PENDO_BASE_URL_PROD;
}

function toNumber(value) {
  if (value == null || value === '') return NaN;
  const normalized = String(value).trim().replace(/%/g, '').replace(/,/g, '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return undefined;
}

function pickCollection(payload, preferredKey) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload[preferredKey])) return payload[preferredKey];
  const candidateKeys = ['items', 'results', 'data', 'funnels', 'features'];
  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    for (const key of candidateKeys) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [];
}

async function fetchPendo(path, apiKey, signal) {
  const base = getPendoApiRoot();
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    signal,
    headers: {
      accept: 'application/json',
      'x-pendo-integration-key': apiKey,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.message || body?.error || `Pendo API-fout (${res.status})`;
    throw new Error(String(msg));
  }
  return body;
}

export async function fetchPendoFunnels(apiKey, signal) {
  const payload = await fetchPendo('/funnel', apiKey, signal);
  const rawFunnels = pickCollection(payload, 'funnels');
  return rawFunnels.map((raw, index) => {
    const id =
      String(
        pickFirst(raw, ['id', 'funnelId', '_id', 'name']) || `funnel-${index + 1}`
      ).trim();
    const name = String(
      pickFirst(raw, ['name', 'title', 'displayName', 'funnelName']) ||
        `Funnel ${index + 1}`
    ).trim();
    return { id, name, raw };
  });
}

export function normalizePendoFunnelForReport(funnelRaw) {
  const stepsSource = Array.isArray(funnelRaw?.steps)
    ? funnelRaw.steps
    : Array.isArray(funnelRaw?.rows)
      ? funnelRaw.rows
      : Array.isArray(funnelRaw)
        ? funnelRaw
        : [];
  const rows = [];
  stepsSource.forEach((step, index) => {
    const label = String(
      pickFirst(step, ['step', 'name', 'title', 'label', 'eventName']) ||
        `Stap ${index + 1}`
    ).trim();
    const usersRaw = pickFirst(step, [
      'users',
      'visitors',
      'visitorCount',
      'count',
      'uniqueVisitors',
      'total',
    ]);
    const users = toNumber(usersRaw);
    if (!Number.isFinite(users)) return;
    rows.push({
      step: label,
      users,
    });
  });
  if (!rows.length) {
    return null;
  }
  return {
    fields: ['step', 'users'],
    rows,
  };
}

export async function fetchPendoFeatures(apiKey, signal) {
  const payload = await fetchPendo('/feature', apiKey, signal);
  const rawFeatures = pickCollection(payload, 'features');
  const features = rawFeatures
    .map((raw) => {
      const feature = String(
        pickFirst(raw, ['name', 'feature', 'title', 'displayName', 'id']) || ''
      ).trim();
      if (!feature) return null;
      const adoptionRaw = pickFirst(raw, [
        'adoption',
        'adoptionRate',
        'adoption_rate',
        'percentage',
        'percent',
        'rate',
        'usageRate',
      ]);
      let adoption = toNumber(adoptionRaw);
      if (!Number.isFinite(adoption)) return null;
      if (adoption > 0 && adoption <= 1) {
        adoption *= 100;
      }
      const usersRaw = pickFirst(raw, ['users', 'visitorCount', 'count', 'visitors']);
      const users = toNumber(usersRaw);
      return {
        feature,
        adoption,
        users: Number.isFinite(users) ? users : null,
      };
    })
    .filter(Boolean);
  return features;
}
