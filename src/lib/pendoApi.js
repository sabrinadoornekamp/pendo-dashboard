const PENDO_BASE_URL_PROD = 'https://app.eu.pendo.io/api/v1';

export function getPendoApiRoot() {
  const override = (process.env.REACT_APP_PENDO_API_URL || '').trim();
  if (override) return override.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'development') {
    return '/pendo-api';
  }
  return PENDO_BASE_URL_PROD;
}

function getPendoScopedApiRoot() {
  const subscriptionId = (
    process.env.REACT_APP_PENDO_SUBSCRIPTION_ID || ''
  ).trim();
  if (!subscriptionId) return null;
  if (process.env.NODE_ENV === 'development') {
    return `/pendo-api-s/${subscriptionId}`;
  }
  return `https://app.eu.pendo.io/api/s/${encodeURIComponent(subscriptionId)}`;
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
  const candidateKeys = [
    'items',
    'results',
    'data',
    'funnels',
    'features',
    'trackedFeatures',
    'featureList',
    'rows',
    'records',
  ];
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

function pickFeatureArray(payload) {
  if (Array.isArray(payload)) return payload;
  const preferred = [
    'features',
    'trackedFeatures',
    'featureList',
    'items',
    'results',
    'rows',
    'records',
    'data',
  ];
  for (const key of preferred) {
    const arr = pickCollection(payload, key);
    if (arr.length) return arr;
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

/** Zoek in geneste objecten naar een getal dat op adoptie % lijkt. */
function findAdoptionNumberDeep(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return NaN;
  const keyHints =
    /adoption|adopt|percent|pct|usageRate|engagementRate|usage/i;
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      const nested = findAdoptionNumberDeep(v, depth + 1);
      if (Number.isFinite(nested)) return nested;
      continue;
    }
    if (!keyHints.test(k)) continue;
    const n = toNumber(v);
    if (!Number.isFinite(n)) continue;
    if (n >= 0 && n <= 1) return n * 100;
    if (n >= 0 && n <= 100) return n;
  }
  return NaN;
}

function normalizePercentAdoption(n) {
  if (!Number.isFinite(n)) return NaN;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

async function fetchPendo(path, apiKey, signal) {
  const base = getPendoApiRoot();
  return fetchPendoFromBase(base, path, apiKey, signal);
}

function appendNoCacheTs(rawUrl) {
  const sep = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${sep}_ts=${Date.now()}`;
}

async function fetchPendoFromBase(base, path, apiKey, signal, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const bodyPayload = options.body;
  const rawUrl = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const url = appendNoCacheTs(rawUrl);
  const headers = {
    accept: 'application/json',
    'x-pendo-integration-key': apiKey,
  };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    signal,
    cache: 'no-store',
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(bodyPayload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      body?.message ||
      body?.error ||
      (typeof body === 'string' ? body : '') ||
      `Pendo API-fout (${res.status})`;
    throw new Error(`${String(msg)} (${url})`);
  }
  return body;
}

/**
 * Haal een specifieke CSV-export op via Pendo endpoint-path.
 * Voorbeelden: "/report/<id>/export?format=csv" of "/aggregation/export?...".
 */
export async function fetchPendoCsvFromPath(path, apiKey, signal) {
  const cleanPath = String(path || '').trim();
  if (!cleanPath) {
    throw new Error('CSV-path ontbreekt.');
  }
  if (/^https?:\/\//i.test(cleanPath)) {
    throw new Error(
      'Gebruik een endpoint-path (bijv. /report/<id>/export?format=csv), geen volledige URL.'
    );
  }

  const bases = [getPendoScopedApiRoot(), getPendoApiRoot()].filter(Boolean);
  let lastErr = null;

  for (const base of bases) {
    const rawUrl = `${base}${cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`}`;
    const url = appendNoCacheTs(rawUrl);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, {
        method: 'GET',
        signal,
        cache: 'no-store',
        headers: {
          accept: 'text/csv,application/csv,text/plain,application/octet-stream',
          'x-pendo-integration-key': apiKey,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (!res.ok) {
        const msg = text?.trim() || `Pendo API-fout (${res.status})`;
        throw new Error(`${msg} (${url})`);
      }
      if (!text || !text.trim()) {
        throw new Error(`Lege CSV-response (${url})`);
      }
      return text;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      if (msg.includes('(404') || msg.includes('(403') || msg.includes('(422')) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('CSV ophalen uit Pendo mislukte.');
}

/**
 * Pendo EU/US: GET /api/v1/funnel bestaat niet (404). Lijsten komen typisch van GET /report.
 * Optioneel: REACT_APP_PENDO_FUNNEL_PATHS="/funnel,/report" (comma-gescheiden, volgorde = probeervolgorde).
 */
function funnelListPaths() {
  const fromEnv = (process.env.REACT_APP_PENDO_FUNNEL_PATHS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return ['/funnel', '/funnels', '/report'];
}

async function fetchPendoFirstOkPath(paths, apiKey, signal) {
  const base = getPendoApiRoot();
  let last404 = null;
  for (const path of paths) {
    const p = path.startsWith('/') ? path : `/${path}`;
    const rawUrl = `${base}${p}`;
    const sep = rawUrl.includes('?') ? '&' : '?';
    const url = `${rawUrl}${sep}_ts=${Date.now()}`;
    const res = await fetch(url, {
      method: 'GET',
      signal,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'x-pendo-integration-key': apiKey,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      last404 = url;
      continue;
    }
    if (!res.ok) {
      const msg =
        body?.message ||
        body?.error ||
        `Pendo API-fout (${res.status})`;
      throw new Error(`${String(msg)} (${url})`);
    }
    return { body, url };
  }
  throw new Error(
    `Geen funnel- of rapportlijst gevonden (404). Pendo heeft geen werkend GET /funnel op de EU API; ` +
      `we proberen o.a. /report. Laatste 404: ${last404 || '—'}. ` +
      `Controleer REACT_APP_PENDO_API_URL (EU: https://app.eu.pendo.io/api/v1) en je integration key.`
  );
}

function isLikelyFunnelOrJourneyReport(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const typeStr = String(
    pickFirst(raw, ['kind', 'type', 'reportType', 'reportKind', 'subtype']) || ''
  ).toLowerCase();
  if (typeStr.includes('funnel')) return true;
  if (typeStr.includes('path') || typeStr.includes('journey')) return true;
  if (Array.isArray(raw.steps) && raw.steps.length) return true;
  if (Array.isArray(raw.definition?.steps) && raw.definition.steps.length) {
    return true;
  }
  return false;
}

/** `funnel` | `path` | `other` — voor filteren in de UI. */
export function inferPendoReportKind(raw) {
  if (!isLikelyFunnelOrJourneyReport(raw)) return 'other';
  const typeStr = String(
    pickFirst(raw, ['kind', 'type', 'reportType', 'reportKind', 'subtype']) || ''
  ).toLowerCase();
  if (typeStr.includes('path') || typeStr.includes('journey')) return 'path';
  return 'funnel';
}

function normalizeRawReportListFromPayload(payload) {
  let rawList = pickCollection(payload, 'funnels');
  if (!rawList.length) {
    rawList = pickCollection(payload, 'reports');
  }
  if (!rawList.length && Array.isArray(payload)) {
    rawList = payload;
  }
  return rawList;
}

/**
 * Alle opgeslagen rapporten uit Pendo (zelfde bron als GET /report), met type-hint.
 * Geen automatische filtering — de analist kiest in de UI.
 */
export async function fetchPendoReportCatalog(apiKey, signal, options = {}) {
  let payload = null;
  const scoped = getPendoScopedApiRoot();
  if (scoped) {
    try {
      payload = await fetchPendoFromBase(scoped, '/report', apiKey, signal);
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    const result = await fetchPendoFirstOkPath(funnelListPaths(), apiKey, signal);
    payload = result.body;
  }
  const rawList = normalizeRawReportListFromPayload(payload);
  if (!rawList.length) {
    throw new Error(
      'Pendo gaf geen rapporten terug (lege lijst). Controleer integration key, EU vs US host, en of er opgeslagen rapporten bestaan.'
    );
  }
  const seen = new Set();
  let entries = rawList.map((raw, index) => {
    const baseId = String(
      pickFirst(raw, ['id', 'reportId', 'funnelId', '_id']) || `item-${index + 1}`
    ).trim();
    let id = baseId;
    if (seen.has(id)) id = `${baseId}__${index}`;
    seen.add(id);
    const name = String(
      pickFirst(raw, ['name', 'title', 'displayName', 'funnelName', 'reportName']) ||
        `Rapport ${index + 1}`
    ).trim();
    return {
      id,
      name,
      kind: inferPendoReportKind(raw),
      raw,
    };
  });
  const dashboardId = String(options?.dashboardId || '').trim();
  if (!dashboardId) return entries;

  const directScoped = entries.filter((e) =>
    entryLooksLinkedToDashboard(e.raw, dashboardId)
  );
  if (directScoped.length) {
    return directScoped;
  }

  const allowed = await fetchPendoDashboardReportIds(dashboardId, apiKey, signal);
  if (!allowed.size) {
    return entries.map((entry) => ({
      ...entry,
      scopeWarning:
        `Dashboard-scope kon geen report-IDs uitlezen voor "${dashboardId}". ` +
        'Catalogus is wel geladen, maar niet gefilterd op dashboard.',
    }));
  }
  entries = entries.filter((e) => allowed.has(String(e.id)));
  if (!entries.length) {
    return rawList.map((raw, index) => ({
      id: String(
        pickFirst(raw, ['id', 'reportId', 'funnelId', '_id']) || `item-${index + 1}`
      ).trim(),
      name: String(
        pickFirst(raw, ['name', 'title', 'displayName', 'funnelName', 'reportName']) ||
          `Rapport ${index + 1}`
      ).trim(),
      kind: inferPendoReportKind(raw),
      raw,
      scopeWarning:
        `Dashboard-scope vond geen overlap met /report voor "${dashboardId}". ` +
        'Catalogus is wel geladen, maar niet gefilterd op dashboard.',
    }));
  }
  return entries;
}

/** @deprecated Gebruik `fetchPendoReportCatalog`; behouden voor oude aanroepen. */
export async function fetchPendoFunnels(apiKey, signal) {
  const entries = await fetchPendoReportCatalog(apiKey, signal);
  const funnelish = entries.filter((e) => e.kind === 'funnel' || e.kind === 'path');
  const use = funnelish.length ? funnelish : entries;
  return use.map(({ id, name, raw }) => ({ id, name, raw }));
}

/**
 * Probeer extra report-detail op te halen, omdat catalogus-items vaak geen volume-data bevatten.
 * We proberen meerdere pad-varianten omdat Pendo tenant/config kan verschillen.
 */
export async function fetchPendoReportDetails(reportId, apiKey, signal) {
  const id = encodeURIComponent(String(reportId || '').trim());
  if (!id) return null;
  const tryPaths = [
    `/report/${id}`,
    `/report?id=${id}`,
    `/report/${id}/results`,
    `/report/${id}/data`,
  ];
  const bases = [getPendoScopedApiRoot(), getPendoApiRoot()].filter(Boolean);
  let lastErr = null;
  for (const base of bases) {
    for (const path of tryPaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const body = await fetchPendoFromBase(base, path, apiKey, signal);
        return body;
      } catch (e) {
        const msg = String(e?.message || '');
        // Veel tenants geven 403 op report-detail met integration key,
        // terwijl lijst- of andere paden wel toegestaan zijn.
        if (msg.includes('(404') || msg.includes('(403')) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
  }
  if (lastErr) return null;
  return null;
}

function extractAggregationPipeline(raw) {
  const pipelineCandidates = [
    raw?.aggregation?.pipeline,
    raw?.report?.aggregation?.pipeline,
    raw?.data?.aggregation?.pipeline,
    raw?.results?.aggregation?.pipeline,
  ];
  for (const candidate of pipelineCandidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return null;
}

/**
 * Fallback: draai de pipeline van een opgeslagen report via POST /aggregation.
 * Werkt tenant-afhankelijk; we proberen meerdere body-vormen op scoped + v1 base.
 */
export async function fetchPendoAggregationForReport(reportRaw, apiKey, signal) {
  const pipeline = extractAggregationPipeline(reportRaw);
  if (!pipeline) return { data: null, debug: null };

  const bases = [getPendoScopedApiRoot(), getPendoApiRoot()].filter(Boolean);
  const bodyShapes = [
    { pipeline },
    pipeline,
    { aggregation: { pipeline } },
    { request: { pipeline } },
  ];

  let lastErr = null;
  const knownFailures = [];
  for (const base of bases) {
    for (const body of bodyShapes) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchPendoFromBase(base, '/aggregation', apiKey, signal, {
          method: 'POST',
          body,
        });
        if (res && typeof res === 'object') return { data: res, debug: null };
      } catch (e) {
        const msg = String(e?.message || '');
        if (
          msg.includes('(404') ||
          msg.includes('(403') ||
          msg.includes('(400') ||
          msg.includes('(422')
        ) {
          lastErr = e;
          knownFailures.push(msg);
          continue;
        }
        throw e;
      }
    }
  }
  if (lastErr && knownFailures.length) {
    const short = knownFailures.slice(0, 2).join(' | ');
    return {
      data: null,
      debug: `Pendo Aggregation API gaf geen bruikbare response (${knownFailures.length} poging(en)). Details: ${short}`,
    };
  }
  return { data: null, debug: null };
}

function collectReportIdsDeep(input, out, depth = 0) {
  if (depth > 8 || input == null) return;
  if (Array.isArray(input)) {
    input.forEach((v) => collectReportIdsDeep(v, out, depth + 1));
    return;
  }
  if (typeof input !== 'object') return;

  const typeHint = String(
    pickFirst(input, [
      'type',
      'kind',
      'reportType',
      'itemType',
      'widgetType',
      'moduleType',
      'cardType',
    ]) || ''
  ).toLowerCase();
  const directId = pickFirst(input, ['id', 'reportId', 'funnelId', 'savedReportId']);
  if (
    directId != null &&
    /(report|funnel|path|journey)/.test(typeHint)
  ) {
    out.add(String(directId));
  }
  if (input.report && typeof input.report === 'object') {
    const nestedReportId = pickFirst(input.report, ['id', 'reportId', 'savedReportId']);
    if (nestedReportId != null) out.add(String(nestedReportId));
  }
  if (input.savedReport && typeof input.savedReport === 'object') {
    const nestedSavedId = pickFirst(input.savedReport, ['id', 'reportId', 'savedReportId']);
    if (nestedSavedId != null) out.add(String(nestedSavedId));
  }

  for (const [k, v] of Object.entries(input)) {
    const kl = k.toLowerCase();
    if (
      (kl === 'reportid' || kl === 'funnelid' || kl === 'savedreportid') &&
      (typeof v === 'string' || typeof v === 'number')
    ) {
      out.add(String(v));
    }
    if (kl === 'reportids' && Array.isArray(v)) {
      v.forEach((id) => {
        if (id != null) out.add(String(id));
      });
    }
    if (
      (kl === 'id' || kl.endsWith('id')) &&
      (typeof v === 'string' || typeof v === 'number') &&
      (kl.includes('report') || kl.includes('funnel'))
    ) {
      out.add(String(v));
    }
    collectReportIdsDeep(v, out, depth + 1);
  }
}

function collectDashboardIdsDeep(input, out, depth = 0) {
  if (depth > 8 || input == null) return;
  if (Array.isArray(input)) {
    input.forEach((v) => collectDashboardIdsDeep(v, out, depth + 1));
    return;
  }
  if (typeof input !== 'object') return;
  for (const [k, v] of Object.entries(input)) {
    const kl = k.toLowerCase();
    if (
      (kl === 'dashboardid' || kl === 'dashboard_id') &&
      (typeof v === 'string' || typeof v === 'number')
    ) {
      out.add(String(v));
    }
    if ((kl === 'dashboardids' || kl === 'dashboards') && Array.isArray(v)) {
      v.forEach((item) => {
        if (item == null) return;
        if (typeof item === 'string' || typeof item === 'number') {
          out.add(String(item));
          return;
        }
        if (typeof item === 'object') {
          const id = pickFirst(item, ['id', 'dashboardId', 'dashboard_id']);
          if (id != null) out.add(String(id));
        }
      });
    }
    if (
      (kl === 'id' || kl.endsWith('id')) &&
      (typeof v === 'string' || typeof v === 'number') &&
      kl.includes('dashboard')
    ) {
      out.add(String(v));
    }
    collectDashboardIdsDeep(v, out, depth + 1);
  }
}

function entryLooksLinkedToDashboard(raw, dashboardId) {
  if (!raw || typeof raw !== 'object') return false;
  const want = String(dashboardId || '').trim();
  if (!want) return false;
  const ids = new Set();
  collectDashboardIdsDeep(raw, ids);
  return ids.has(want);
}

async function fetchPendoDashboardReportIds(dashboardId, apiKey, signal) {
  const id = encodeURIComponent(String(dashboardId || '').trim());
  if (!id) return new Set();
  const tryPaths = [
    `/dashboard/${id}`,
    `/dashboard?id=${id}`,
    `/dashboards/${id}`,
    `/dashboard/${id}/reports`,
    `/dashboards/${id}/reports`,
    `/dashboard/${id}/widgets`,
    `/dashboards/${id}/widgets`,
    `/dashboards?id=${id}`,
  ];
  const bases = [getPendoScopedApiRoot(), getPendoApiRoot()].filter(Boolean);
  const ids = new Set();
  for (const base of bases) {
    for (const path of tryPaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const body = await fetchPendoFromBase(base, path, apiKey, signal);
        collectReportIdsDeep(body, ids);
        if (ids.size) return ids;
      } catch (e) {
        const msg = String(e?.message || '');
        if (msg.includes('(404') || msg.includes('(403')) {
          continue;
        }
        throw e;
      }
    }
  }
  return ids;
}

const STEP_LABEL_KEYS = [
  'step',
  'name',
  'title',
  'label',
  'eventName',
  'pageTitle',
  'page',
  'rule',
  'stepName',
  'displayName',
  'prettyName',
  'description',
  'event',
  'target',
  'pageName',
  'screenName',
];

const STEP_USER_KEYS = [
  'users',
  'visitors',
  'visitorCount',
  'uniqueVisitors',
  'uniqueVisitorCount',
  'uniqueUsers',
  'count',
  'total',
  'value',
  'completed',
  'numerator',
  'volume',
  'nVisitors',
  'visitor',
  'visits',
  'attempts',
  'sessions',
];

function funnelStepsFromRaw(funnelRaw) {
  if (!funnelRaw || typeof funnelRaw !== 'object') return [];
  if (Array.isArray(funnelRaw)) return funnelRaw;
  const tryPaths = [
    funnelRaw.steps,
    funnelRaw.rows,
    funnelRaw.definition?.steps,
    funnelRaw.config?.steps,
    funnelRaw.configuration?.steps,
    funnelRaw.funnel?.steps,
    funnelRaw.report?.definition?.steps,
    funnelRaw.data?.steps,
    funnelRaw.results?.steps,
    funnelRaw.report?.steps,
    funnelRaw.savedReport?.definition?.steps,
    funnelRaw.definition?.funnel?.steps,
    funnelRaw.data?.rows,
    funnelRaw.results?.rows,
    funnelRaw.output?.steps,
    funnelRaw.output?.rows,
  ];
  for (const arr of tryPaths) {
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return [];
}

/** Zoek een plausibel bezoekers-/volumegetal in geneste objecten (Pendo varieert sterk). */
function findVisitorCountDeep(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return NaN;
  if (Array.isArray(obj)) return NaN;
  let best = NaN;
  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();
    const keyLooksMetric =
      /visitor|unique|user|count|total|volume|completed|numerator|sessions/.test(
        kl
      ) && !/percent|rate|ratio|adoption|fraction/.test(kl);
    if (keyLooksMetric && (typeof v === 'number' || typeof v === 'string')) {
      const n = toNumber(v);
      if (Number.isFinite(n) && n >= 0 && n < 1e12) {
        if (!Number.isFinite(best) || n > best) best = n;
      }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const n = findVisitorCountDeep(v, depth + 1);
      if (Number.isFinite(n) && (!Number.isFinite(best) || n > best)) best = n;
    }
  }
  return best;
}

function stepVisitorCount(step) {
  if (step == null) return NaN;
  if (typeof step === 'number' || typeof step === 'string') {
    return toNumber(step);
  }
  if (typeof step !== 'object') return NaN;

  let n = toNumber(pickFirst(step, STEP_USER_KEYS));
  if (Number.isFinite(n)) return n;

  for (const nest of [
    'metrics',
    'stats',
    'data',
    'values',
    'result',
    'aggregates',
    'summary',
    'counts',
    'event',
    'stepData',
  ]) {
    const b = step[nest];
    if (!b || typeof b !== 'object') continue;
    n = toNumber(pickFirst(b, STEP_USER_KEYS));
    if (Number.isFinite(n)) return n;
  }

  n = findVisitorCountDeep(step);
  return n;
}

function stepLabel(step, index) {
  if (step == null) return `Stap ${index + 1}`;
  if (typeof step === 'string' || typeof step === 'number') {
    return String(step).trim() || `Stap ${index + 1}`;
  }
  if (typeof step !== 'object') return `Stap ${index + 1}`;
  const direct = pickFirst(step, STEP_LABEL_KEYS);
  if (direct != null && String(direct).trim() !== '') {
    return String(direct).trim();
  }
  const ev = step.event || step.rule;
  if (ev && typeof ev === 'object') {
    const evLabel = pickFirst(ev, ['name', 'title', 'label', 'id', 'rule']);
    if (evLabel != null && String(evLabel).trim() !== '') {
      return String(evLabel).trim();
    }
  }
  return `Stap ${index + 1}`;
}

/** Paar parallelle arrays (grafiek-/exportvorm). */
function tryRowsFromPairedArrays(raw) {
  const labels =
    raw.labels ??
    raw.stepLabels ??
    raw.names ??
    raw.categories ??
    raw.stepsNames;
  const counts =
    raw.values ??
    raw.counts ??
    raw.series ??
    raw.numbers ??
    raw.dataCounts ??
    raw.y;

  if (!Array.isArray(labels) || !Array.isArray(counts)) return [];
  const n = Math.min(labels.length, counts.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const users = toNumber(counts[i]);
    if (!Number.isFinite(users)) continue;
    const lab = labels[i];
    const step =
      typeof lab === 'object' && lab != null
        ? stepLabel(lab, i)
        : String(lab ?? `Stap ${i + 1}`).trim() || `Stap ${i + 1}`;
    out.push({ step, users });
  }
  return out;
}

/** Rijen als losse objecten met willekeurige kolommen: zoek tekst- + getalkolom. */
function tryRowsFromObjectTable(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const sample = rows.find((r) => r && typeof r === 'object');
  if (!sample) return [];
  const keys = Object.keys(sample);
  if (!keys.length) return [];

  let usersCol = null;
  let bestScore = 0;
  for (const col of keys) {
    const kl = col.toLowerCase();
    if (/name|label|title|step|page|event|rule|screen/.test(kl) && !/\d/.test(kl)) {
      continue;
    }
    let num = 0;
    for (const row of rows) {
      const n = toNumber(row[col]);
      if (Number.isFinite(n) && n >= 0 && n < 1e12) num++;
    }
    const score = rows.length ? num / rows.length : 0;
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      usersCol = col;
    }
  }
  if (!usersCol) {
    for (const col of keys) {
      const kl = col.toLowerCase();
      if (
        /visitor|user|count|unique|volume|total|n$/.test(kl) &&
        !/percent|rate|pct/.test(kl)
      ) {
        usersCol = col;
        break;
      }
    }
  }
  if (!usersCol) return [];

  let stepCol = keys.find((k) => {
    const kl = k.toLowerCase();
    return (
      k !== usersCol &&
      (/step|name|label|title|page|event|screen|rule/.test(kl) ||
        kl === 'key' ||
        kl === 'id')
    );
  });
  if (!stepCol) {
    stepCol = keys.find((k) => k !== usersCol) || keys[0];
  }

  const out = [];
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const users = toNumber(row[usersCol]);
    if (!Number.isFinite(users)) return;
    const labelRaw = row[stepCol];
    const step =
      labelRaw != null && String(labelRaw).trim() !== ''
        ? String(labelRaw).trim()
        : `Stap ${i + 1}`;
    out.push({ step, users });
  });
  return out;
}

function getDefinitionStepLabels(raw) {
  const from = raw?.definition?.steps || raw?.report?.definition?.steps;
  if (!Array.isArray(from) || !from.length) return [];
  return from.map((step, i) => stepLabel(step, i));
}

function rowsFromAggregationBlock(block, fallbackLabels = []) {
  if (!block || typeof block !== 'object') return [];

  const tableCandidates = [
    block.rows,
    block.data?.rows,
    block.results?.rows,
    block.output?.rows,
    block.table?.rows,
  ];
  for (const rows of tableCandidates) {
    const parsed = tryRowsFromObjectTable(rows);
    if (parsed.length >= 2) return parsed;
    if (!Array.isArray(rows)) continue;
    const direct = [];
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      const users = toNumber(
        pickFirst(row, ['count', 'counts', 'users', 'visitors', 'visitorCount', 'value'])
      );
      if (!Number.isFinite(users)) return;
      const stepRaw = pickFirst(row, ['step', 'steps', 'name', 'label', 'title', 'key']);
      const idx = toNumber(stepRaw);
      let step = '';
      if (Number.isFinite(idx) && idx >= 0) {
        step = fallbackLabels[Math.floor(idx)] || `Stap ${Math.floor(idx) + 1}`;
      } else {
        step =
          stepRaw != null && String(stepRaw).trim() !== ''
            ? String(stepRaw).trim()
            : fallbackLabels[i] || `Stap ${i + 1}`;
      }
      direct.push({ step, users });
    });
    if (direct.length >= 2) return direct;
  }

  const countArrays = [
    block.counts,
    block.data?.counts,
    block.results?.counts,
    block.output?.counts,
  ];
  for (const arr of countArrays) {
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const rows = arr
      .map((v, i) => {
        const users = toNumber(v);
        if (!Number.isFinite(users)) return null;
        return {
          step: fallbackLabels[i] || `Stap ${i + 1}`,
          users,
        };
      })
      .filter(Boolean);
    if (rows.length >= 2) return rows;
  }

  return [];
}

function unionFieldsFromRows(rows) {
  const fields = [];
  const seen = new Set();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    Object.keys(row).forEach((k) => {
      if (!seen.has(k)) {
        seen.add(k);
        fields.push(k);
      }
    });
  });
  return fields;
}

function tableFromRowsLike(rowsLike) {
  if (!Array.isArray(rowsLike) || !rowsLike.length) return null;
  const objectRows = rowsLike.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  if (objectRows.length) {
    return {
      fields: unionFieldsFromRows(objectRows),
      rows: objectRows,
    };
  }
  return null;
}

function findFirstObjectArrayDeep(input, depth = 0) {
  if (depth > 6 || input == null) return null;
  if (Array.isArray(input)) {
    const objRows = input.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
    if (objRows.length) return objRows;
    for (const item of input) {
      const hit = findFirstObjectArrayDeep(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof input !== 'object') return null;
  for (const v of Object.values(input)) {
    const hit = findFirstObjectArrayDeep(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function normalizePendoGenericTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const directCandidates = [
    raw.rows,
    raw.data?.rows,
    raw.results?.rows,
    raw.table?.rows,
    raw.reportData?.rows,
    raw.output?.rows,
    raw.aggregationResult?.rows,
    raw.aggregationResult?.data?.rows,
    raw.aggregationResult?.results?.rows,
  ];
  for (const candidate of directCandidates) {
    const t = tableFromRowsLike(candidate);
    if (t?.rows?.length) return t;
  }
  const deep = findFirstObjectArrayDeep(raw);
  return tableFromRowsLike(deep);
}

export function normalizePendoFunnelForReport(funnelRaw) {
  if (!funnelRaw || typeof funnelRaw !== 'object') return null;

  const fromPairs = tryRowsFromPairedArrays(funnelRaw);
  if (fromPairs.length >= 2) {
    return { fields: ['step', 'users'], rows: fromPairs };
  }

  const nestedPairs = tryRowsFromPairedArrays(funnelRaw.data || {});
  if (nestedPairs.length >= 2) {
    return { fields: ['step', 'users'], rows: nestedPairs };
  }

  const nestedPairs2 = tryRowsFromPairedArrays(funnelRaw.results || {});
  if (nestedPairs2.length >= 2) {
    return { fields: ['step', 'users'], rows: nestedPairs2 };
  }

  const tableCandidates = [
    funnelRaw.rows,
    funnelRaw.data?.rows,
    funnelRaw.results?.rows,
    funnelRaw.table?.rows,
    funnelRaw.reportData?.rows,
    funnelRaw.aggregationResult?.rows,
    funnelRaw.aggregationResult?.data?.rows,
    funnelRaw.aggregationResult?.results?.rows,
  ];
  for (const tbl of tableCandidates) {
    const fromTable = tryRowsFromObjectTable(tbl);
    if (fromTable.length >= 2) {
      return { fields: ['step', 'users'], rows: fromTable };
    }
  }

  const fallbackLabels = getDefinitionStepLabels(funnelRaw);
  const aggregationCandidates = [
    funnelRaw.aggregation,
    funnelRaw.aggregationResult,
    funnelRaw.report?.aggregation,
    funnelRaw.data?.aggregation,
    funnelRaw.results?.aggregation,
    funnelRaw.aggregationResult?.aggregation,
  ];
  for (const agg of aggregationCandidates) {
    const fromAggregation = rowsFromAggregationBlock(agg, fallbackLabels);
    if (fromAggregation.length >= 2) {
      return { fields: ['step', 'users'], rows: fromAggregation };
    }
  }

  const stepsSource = funnelStepsFromRaw(funnelRaw);
  const rows = [];
  stepsSource.forEach((step, index) => {
    const users = stepVisitorCount(step);
    if (!Number.isFinite(users)) return;
    rows.push({
      step: stepLabel(step, index),
      users,
    });
  });

  if (rows.length >= 2) {
    return {
      fields: ['step', 'users'],
      rows,
    };
  }

  return null;
}

/**
 * GET /feature levert vaak feature-definities; adoptiepercentages zitten soms dieper
 * (stats/metrics) of ontbreken — dan vullen we 0% en zetten usedAdoptionFallback.
 */
export async function fetchPendoFeatures(apiKey, signal) {
  const payload = await fetchPendo('/feature', apiKey, signal);
  const rawFeatures = pickFeatureArray(payload);

  if (!rawFeatures.length) {
    return { features: [], usedAdoptionFallback: false };
  }

  const rows = [];
  let usedAdoptionFallback = false;

  for (const raw of rawFeatures) {
    if (!raw || typeof raw !== 'object') continue;

    const feature = String(
      pickFirst(raw, [
        'stableLabel',
        'name',
        'prettyName',
        'title',
        'displayName',
        'feature',
        'featureName',
        'label',
        'key',
        'id',
      ]) || ''
    ).trim();
    if (!feature) continue;

    let adoption = NaN;
    const flatAdoption = pickFirst(raw, [
      'adoption',
      'adoptionRate',
      'adoption_rate',
      'adoptionPct',
      'adoptionPercentage',
      'percentage',
      'percent',
      'usageRate',
      'engagementRate',
      'rate',
    ]);
    adoption = normalizePercentAdoption(toNumber(flatAdoption));

    if (!Number.isFinite(adoption)) {
      for (const nest of ['stats', 'metrics', 'usage', 'aggregatedStats', 'summary']) {
        const block = raw[nest];
        if (!block || typeof block !== 'object') continue;
        const v = pickFirst(block, [
          'adoption',
          'adoptionRate',
          'adoption_rate',
          'percentage',
          'percent',
          'usageRate',
        ]);
        adoption = normalizePercentAdoption(toNumber(v));
        if (Number.isFinite(adoption)) break;
      }
    }

    if (!Number.isFinite(adoption)) {
      adoption = findAdoptionNumberDeep(raw);
    }

    const numVisitors = toNumber(
      pickFirst(raw, [
        'numVisitors',
        'lastMonthVisitors',
        'visitorCount',
        'uniqueVisitors',
        'visitors',
        'count',
        'users',
      ])
    );
    const denom = toNumber(
      pickFirst(raw, ['eligibleVisitors', 'totalVisitors', 'denominator', 'base'])
    );
    if (
      !Number.isFinite(adoption) &&
      Number.isFinite(numVisitors) &&
      Number.isFinite(denom) &&
      denom > 0
    ) {
      adoption = (numVisitors / denom) * 100;
    }

    if (!Number.isFinite(adoption)) {
      adoption = 0;
      usedAdoptionFallback = true;
    }

    const usersRaw = pickFirst(raw, [
      'users',
      'visitorCount',
      'uniqueVisitors',
      'visitors',
      'numVisitors',
      'count',
    ]);
    const users = toNumber(usersRaw);

    rows.push({
      feature,
      adoption,
      users: Number.isFinite(users) ? users : null,
    });
  }

  return { features: rows, usedAdoptionFallback };
}

export async function fetchPendoReportTable(reportId, reportRaw, apiKey, signal) {
  const normalizedFromRaw = normalizePendoGenericTable(reportRaw);
  if (normalizedFromRaw?.rows?.length) return normalizedFromRaw;

  const details = await fetchPendoReportDetails(reportId, apiKey, signal);
  if (!details) return null;

  const merged = {
    ...(reportRaw || {}),
    report: details,
    results: details?.results || reportRaw?.results,
    data: details?.data || reportRaw?.data,
    rows: details?.rows || reportRaw?.rows,
  };
  return normalizePendoGenericTable(merged);
}
