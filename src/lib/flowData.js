import LZString from 'lz-string';
import Papa from 'papaparse';

// TODO: replace localStorage with a database when scaling up, and replace CSV upload with Pendo API

const LS_REPORTS = 'tl_userflow_reports';

/** Fout bij localStorage-quota (±5 MB per site); zie persistReportPatch / createReport. */
export const STORAGE_QUOTA_MESSAGE_NL =
  'De browseropslag zit vol (grote CSV). Verwijder oude dashboards, maak de export kleiner, of leeg sitegegevens voor localhost.';

const MAX_CSV_FOR_CLAUDE = 120000;
const LS_PIJN_MAP = 'tl_userflow_pijnpunten_by_report';

/** Legacy keys (eenmalig migreren naar LS_REPORTS) */
const LS_FUNNEL = 'tl_userflow_funnel';
const LS_FEATURES = 'tl_userflow_features';
const LS_UPDATED = 'tl_userflow_updated_at';
const LS_PIJN_CACHE = 'tl_userflow_pijnpunten_cache';

/** Vaste volgorde in de zijbalk (professional / cliënt zoals UX-prototype). */
export const REPORT_FLOW_GROUP_ORDER = ['professional', 'client', 'general'];

export const REPORT_FLOW_GROUPS = [
  { id: 'professional', sidebarLabel: 'Professionele flows' },
  { id: 'client', sidebarLabel: 'Cliëntflows' },
  { id: 'general', sidebarLabel: 'Overig' },
];

export function normalizeFlowGroupId(raw) {
  const s = String(raw ?? '').trim();
  if (REPORT_FLOW_GROUP_ORDER.includes(s)) return s;
  return 'general';
}

export function getFlowGroupSidebarLabel(id) {
  return (
    REPORT_FLOW_GROUPS.find((g) => g.id === normalizeFlowGroupId(id))
      ?.sidebarLabel ?? 'Overig'
  );
}

/**
 * Groepeer rapporten voor de sidebar (alleen groepen met ≥1 dashboard).
 * Behoudt de volgorde binnen elke groep zoals in `reportsSorted`.
 */
export function groupReportsByFlowGroup(reportsSorted) {
  const buckets = new Map(REPORT_FLOW_GROUP_ORDER.map((id) => [id, []]));
  for (const r of reportsSorted) {
    const g = normalizeFlowGroupId(r.flowGroup);
    buckets.get(g).push(r);
  }
  return REPORT_FLOW_GROUP_ORDER.filter((id) => buckets.get(id).length > 0).map(
    (id) => ({
      groupId: id,
      label: getFlowGroupSidebarLabel(id),
      reports: buckets.get(id),
    })
  );
}

const USERS_HEADER_CANDIDATES = [
  'users',
  'gebruikers',
  'count',
  'aantal',
  'visitors',
  'volume',
  'unique users',
  'unique_users',
];

/** Funnel-stap / schermnaam (heuristiek op Pendo-achtige exports). */
const STEP_HEADER_CANDIDATES = [
  'step',
  'stap',
  'page',
  'screen',
  'event',
  'name',
  'label',
  'funnel step',
  'step name',
  'screen name',
  'pagina',
  'event name',
  'title',
];

const FEATURE_HEADER_CANDIDATES = [
  'feature',
  'feature_name',
  'naam',
  'name',
];
const ADOPTION_HEADER_CANDIDATES = [
  'adoption',
  'adoption_rate',
  'adoption %',
  'adoption%',
  'percentage',
  'rate',
  'adoptie',
  'pct',
];

function normalizeHeaderKey(h) {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function findColumn(headers, candidates) {
  if (!headers?.length) return null;
  const byNorm = new Map(
    headers.map((raw) => [normalizeHeaderKey(raw), raw])
  );
  for (const c of candidates) {
    const hit = byNorm.get(normalizeHeaderKey(c));
    if (hit) return hit;
  }
  for (const raw of headers) {
    const k = normalizeHeaderKey(raw);
    for (const c of candidates) {
      const cn = normalizeHeaderKey(c);
      if (k.includes(cn) || cn.includes(k)) return raw;
    }
  }
  return null;
}

function coerceNumber(val) {
  if (val == null || val === '') return NaN;
  const s = String(val).replace(/%/g, '').replace(/\s/g, '').replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Ruwe funnel-export: geen kolomvalidatie; zoals Papa Parse hem teruggeeft. */
export function rawFunnelFromPapaResults(results) {
  const fields = results.meta.fields?.filter(Boolean) ?? [];
  const data = Array.isArray(results.data) ? results.data : [];
  const rows = data.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    return Object.values(row).some(
      (v) => v != null && String(v).trim() !== ''
    );
  });
  return { fields, rows };
}

export function buildFeatureRows(rows, featureCol, adoptionCol, usersCol) {
  const out = [];
  for (const row of rows) {
    const feature = row[featureCol];
    if (feature == null || String(feature).trim() === '') continue;
    const adoption = coerceNumber(row[adoptionCol]);
    const users = usersCol ? coerceNumber(row[usersCol]) : NaN;
    if (!Number.isFinite(adoption)) continue;
    out.push({
      feature: String(feature).trim(),
      adoption,
      users: Number.isFinite(users) ? users : null,
    });
  }
  return out;
}

export function parseFeatureCsvResults(results) {
  const headers = results.meta.fields?.filter(Boolean) ?? [];
  const featureCol = findColumn(headers, FEATURE_HEADER_CANDIDATES);
  const adoptionCol = findColumn(headers, ADOPTION_HEADER_CANDIDATES);
  const usersCol = findColumn(headers, USERS_HEADER_CANDIDATES);
  if (!featureCol || !adoptionCol) {
    return {
      ok: false,
      error:
        'Geen geldige featurekolommen. Gebruik o.a. "feature" en "adoption"/"percentage".',
    };
  }
  const rows = buildFeatureRows(
    results.data,
    featureCol,
    adoptionCol,
    usersCol
  );
  if (!rows.length) {
    return { ok: false, error: 'Geen geldige feature-adoptierijen gevonden.' };
  }
  return { ok: true, data: rows };
}

function normalizeStoredFunnel(funnel) {
  if (funnel == null) return null;
  if (Array.isArray(funnel)) return funnel;
  if (typeof funnel === 'object' && Array.isArray(funnel.rows)) {
    return {
      ...funnel,
      fields: Array.isArray(funnel.fields) ? funnel.fields : [],
    };
  }
  return null;
}

function normalizeStoredReport(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    title: String(raw.title || 'Naamloos dashboard').trim() || 'Naamloos dashboard',
    flowGroup: normalizeFlowGroupId(raw.flowGroup),
    funnelCsvZ: typeof raw.funnelCsvZ === 'string' ? raw.funnelCsvZ : null,
    funnel: raw.funnel != null ? normalizeStoredFunnel(raw.funnel) : null,
    features: Array.isArray(raw.features) ? raw.features : null,
    featuresZ: typeof raw.featuresZ === 'string' ? raw.featuresZ : null,
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

function saveReportsStore(store) {
  try {
    localStorage.setItem(
      LS_REPORTS,
      JSON.stringify({
        reports: store.reports,
        lastActiveReportId: store.lastActiveReportId,
      })
    );
    return { ok: true };
  } catch (e) {
    const name = e?.name || '';
    if (
      name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED'
    ) {
      return { ok: false, code: 'QUOTA', message: STORAGE_QUOTA_MESSAGE_NL };
    }
    return {
      ok: false,
      code: 'UNKNOWN',
      message: e?.message || 'Opslaan mislukt.',
    };
  }
}

export function getFunnelCsvText(report) {
  if (!report?.funnelCsvZ) return null;
  try {
    const t = LZString.decompressFromUTF16(report.funnelCsvZ);
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function getReportFeatures(report) {
  if (!report) return null;
  if (Array.isArray(report.features) && report.features.length > 0) {
    return report.features;
  }
  if (report.featuresZ) {
    try {
      const s = LZString.decompressFromUTF16(report.featuresZ);
      if (!s) return null;
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function getFunnelParsedForUi(report) {
  const csv = getFunnelCsvText(report);
  if (csv) {
    const results = Papa.parse(csv, {
      header: true,
      skipEmptyLines: 'greedy',
    });
    return rawFunnelFromPapaResults(results);
  }
  return report?.funnel ?? null;
}

export function normalizeFunnelTableForReport(report) {
  return normalizeFunnelTable(getFunnelParsedForUi(report));
}

function funnelRowCountLegacy(funnel) {
  if (!funnel) return 0;
  if (Array.isArray(funnel)) return funnel.length;
  return Array.isArray(funnel.rows) ? funnel.rows.length : 0;
}

export function reportHasFunnelData(report) {
  if (!report) return false;
  if (report.funnelCsvZ) return true;
  return funnelRowCountLegacy(report.funnel) > 0;
}

export function reportHasFeatureData(report) {
  if (!report) return false;
  if (Array.isArray(report.features) && report.features.length > 0) {
    return true;
  }
  return !!report.featuresZ;
}

function migrateLegacyIfNeeded() {
  try {
    if (localStorage.getItem(LS_REPORTS)) return;
    const oldF = localStorage.getItem(LS_FUNNEL);
    const oldFe = localStorage.getItem(LS_FEATURES);
    if (!oldF && !oldFe) return;

    let funnel = null;
    let features = null;
    if (oldF) funnel = normalizeStoredFunnel(JSON.parse(oldF));
    if (oldFe) {
      const p = JSON.parse(oldFe);
      features = Array.isArray(p) ? p : null;
    }
    const oldU = localStorage.getItem(LS_UPDATED);
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `r-${Date.now()}`;
    const report = {
      id,
      title: 'Mijn eerste dashboard',
      flowGroup: 'general',
      funnelCsvZ: null,
      funnel,
      features,
      featuresZ: null,
      updatedAt: oldU || new Date().toISOString(),
    };
    saveReportsStore({ reports: [report], lastActiveReportId: id });

    localStorage.removeItem(LS_FUNNEL);
    localStorage.removeItem(LS_FEATURES);
    localStorage.removeItem(LS_UPDATED);

    const oldPijn = localStorage.getItem(LS_PIJN_CACHE);
    if (oldPijn) {
      try {
        const o = JSON.parse(oldPijn);
        if (o?.updatedAt && typeof o.text === 'string') {
          savePijnpuntenCache(id, o.updatedAt, o.text);
        }
      } catch {
        /* ignore */
      }
      localStorage.removeItem(LS_PIJN_CACHE);
    }
  } catch {
    /* ignore */
  }
}

export function loadReportsStore() {
  migrateLegacyIfNeeded();
  try {
    const raw = localStorage.getItem(LS_REPORTS);
    if (!raw) return { reports: [], lastActiveReportId: null };
    const o = JSON.parse(raw);
    const reports = Array.isArray(o.reports)
      ? o.reports.map(normalizeStoredReport).filter(Boolean)
      : [];
    return {
      reports,
      lastActiveReportId: o.lastActiveReportId || null,
    };
  } catch {
    return { reports: [], lastActiveReportId: null };
  }
}

export function listReportsSorted() {
  const { reports } = loadReportsStore();
  return [...reports].sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );
}

export function loadReport(reportId) {
  if (!reportId) return null;
  const { reports } = loadReportsStore();
  return reports.find((r) => r.id === reportId) || null;
}

/** Zonder opnieuw localStorage te parsen (gebruik snapshot van loadReportsStore()). */
export function pickDefaultReportId(store) {
  const { reports, lastActiveReportId } = store || {
    reports: [],
    lastActiveReportId: null,
  };
  if (!reports?.length) return null;
  if (
    lastActiveReportId &&
    reports.some((r) => r.id === lastActiveReportId)
  ) {
    return lastActiveReportId;
  }
  const withData = reports.find((r) => hasDashboardData(r));
  return withData?.id || reports[0]?.id || null;
}

export function resolveEffectiveReportId(store, paramId) {
  const { reports } = store || { reports: [] };
  if (!reports?.length) return null;
  if (paramId && reports.some((r) => r.id === paramId)) return paramId;
  return pickDefaultReportId(store);
}

export function getDefaultReportId() {
  return pickDefaultReportId(loadReportsStore());
}

export function createReport(title, options = {}) {
  const store = loadReportsStore();
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `r-${Date.now()}`;
  const trimmed = String(title ?? '').trim();
  const report = {
    id,
    title:
      trimmed ||
      `Dashboard ${new Date().toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}`,
    flowGroup: normalizeFlowGroupId(options.flowGroup),
    funnelCsvZ: null,
    funnel: null,
    features: null,
    featuresZ: null,
    updatedAt: new Date().toISOString(),
  };
  store.reports.push(report);
  store.lastActiveReportId = id;
  const saved = saveReportsStore(store);
  if (!saved.ok) {
    store.reports.pop();
    return { ok: false, ...saved };
  }
  return { ok: true, report };
}

export function persistReportPatch(reportId, patch) {
  if (!reportId) {
    return { ok: false, code: 'UNKNOWN', message: 'Geen rapport geselecteerd.' };
  }
  const store = loadReportsStore();
  const idx = store.reports.findIndex((r) => r.id === reportId);
  if (idx < 0) {
    return { ok: false, code: 'UNKNOWN', message: 'Rapport niet gevonden.' };
  }
  const prev = store.reports[idx];
  const r = { ...prev };
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    r.title = t || prev.title;
  }
  if (patch.flowGroup !== undefined) {
    r.flowGroup = normalizeFlowGroupId(patch.flowGroup);
  }
  if (patch.funnelCsv !== undefined) {
    if (patch.funnelCsv === null || patch.funnelCsv === '') {
      r.funnelCsvZ = null;
    } else {
      try {
        r.funnelCsvZ = LZString.compressToUTF16(String(patch.funnelCsv));
      } catch {
        return {
          ok: false,
          code: 'UNKNOWN',
          message: 'Funnel-CSV kon niet worden gecomprimeerd.',
        };
      }
    }
    r.funnel = null;
  }
  if (patch.funnel !== undefined) {
    r.funnel = normalizeStoredFunnel(patch.funnel);
    r.funnelCsvZ = null;
  }
  if (patch.features !== undefined) {
    if (patch.features == null || patch.features.length === 0) {
      r.features = null;
      r.featuresZ = null;
    } else {
      try {
        r.featuresZ = LZString.compressToUTF16(
          JSON.stringify(patch.features)
        );
        r.features = null;
      } catch {
        return {
          ok: false,
          code: 'UNKNOWN',
          message: 'Featuredata kon niet worden gecomprimeerd.',
        };
      }
    }
  }
  r.updatedAt = new Date().toISOString();
  store.reports[idx] = r;
  store.lastActiveReportId = reportId;
  const saved = saveReportsStore(store);
  if (!saved.ok) {
    store.reports[idx] = prev;
    return saved;
  }
  return { ok: true, report: r };
}

export function updateReportTitle(reportId, title) {
  return persistReportPatch(reportId, { title });
}

/** Alleen voor losse funnel-objecten (legacy); voor rapporten: reportHasFunnelData. */
export function funnelRowCount(funnel) {
  return funnelRowCountLegacy(funnel);
}

export function hasDashboardData(report) {
  if (!report) return false;
  return reportHasFunnelData(report) || reportHasFeatureData(report);
}

/**
 * Afleiding van funnel-KPI’s uit genormaliseerde tabel (stappen + gebruikers).
 * Werkt het best als er een duidelijke gebruikerskolom en vaste stapvolgorde is.
 */
export function deriveFunnelFlowMetrics(table) {
  if (!table?.columns?.length || !table?.rows?.length) {
    return { ok: false, reason: 'no_data' };
  }
  const { columns, rows } = table;

  let usersCol = findColumn(columns, USERS_HEADER_CANDIDATES);
  let stepCol = findColumn(columns, STEP_HEADER_CANDIDATES);

  if (!stepCol) {
    stepCol =
      columns.find((c) => c !== usersCol) ?? columns[0];
  }
  if (usersCol && stepCol === usersCol) {
    stepCol = columns.find((c) => c !== usersCol) ?? null;
  }
  if (!stepCol) {
    stepCol = columns[0];
  }

  if (!usersCol) {
    let best = null;
    let bestScore = 0;
    for (const col of columns) {
      if (col === stepCol) continue;
      let num = 0;
      for (const row of rows) {
        const n = coerceNumber(row[col]);
        if (Number.isFinite(n) && n >= 0) num++;
      }
      const score = rows.length ? num / rows.length : 0;
      if (score > bestScore) {
        bestScore = score;
        best = col;
      }
    }
    if (bestScore < 0.45 || !best) {
      return { ok: false, reason: 'no_users_column' };
    }
    usersCol = best;
  }

  if (stepCol === usersCol) {
    stepCol = columns.find((c) => c !== usersCol) ?? columns[0];
  }

  const steps = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const users = coerceNumber(row[usersCol]);
    if (!Number.isFinite(users)) continue;
    const labelRaw = stepCol != null ? row[stepCol] : null;
    const label =
      labelRaw != null && String(labelRaw).trim() !== ''
        ? String(labelRaw).trim()
        : `Stap ${steps.length + 1}`;
    steps.push({ label, users, rowIndex: i });
  }

  if (steps.length < 2) {
    return {
      ok: false,
      reason: 'too_few_steps',
      stepColumn: stepCol,
      usersColumn: usersCol,
    };
  }

  const firstUsers = steps[0].users;
  const lastUsers = steps[steps.length - 1].users;

  const enriched = steps.map((s, idx) => {
    const prevUsers = idx > 0 ? steps[idx - 1].users : null;
    const dropFromPrev =
      prevUsers != null && prevUsers > 0
        ? ((prevUsers - s.users) / prevUsers) * 100
        : null;
    const retentionFromStart =
      firstUsers > 0 ? (s.users / firstUsers) * 100 : null;
    return { ...s, dropFromPrev, retentionFromStart };
  });

  const transitions = [];
  for (let i = 1; i < enriched.length; i++) {
    const prev = enriched[i - 1];
    const curr = enriched[i];
    if (prev.users <= 0) continue;
    const dropPct = ((prev.users - curr.users) / prev.users) * 100;
    transitions.push({
      fromLabel: prev.label,
      toLabel: curr.label,
      dropPct,
      fromUsers: prev.users,
      toUsers: curr.users,
    });
  }

  const topDrops = [...transitions]
    .filter((t) => Number.isFinite(t.dropPct) && t.dropPct > 0)
    .sort((a, b) => b.dropPct - a.dropPct)
    .slice(0, 3);

  const overallRetention =
    firstUsers > 0 ? (lastUsers / firstUsers) * 100 : null;

  return {
    ok: true,
    stepColumn: stepCol,
    usersColumn: usersCol,
    steps: enriched,
    transitions,
    topDrops,
    firstUsers,
    lastUsers,
    overallRetention,
    stepCount: steps.length,
  };
}

/** Tabelweergave: kolommen + rijen (legacy array of { fields, rows }). */
export function normalizeFunnelTable(funnel) {
  if (!funnel) return null;
  if (Array.isArray(funnel)) {
    if (funnel.length === 0) return null;
    const columns = [
      ...new Set(
        funnel.flatMap((r) =>
          r && typeof r === 'object' ? Object.keys(r) : []
        )
      ),
    ];
    return { columns, rows: funnel };
  }
  const rows = funnel.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const fromRows = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const fromFields = Array.isArray(funnel.fields) ? funnel.fields : [];
  const columns = [
    ...fromFields,
    ...fromRows.filter((k) => !fromFields.includes(k)),
  ];
  return { columns, rows };
}

function funnelPayloadForClaude(funnel) {
  if (!funnel) {
    return { columnNames: [], rows: [] };
  }
  if (Array.isArray(funnel)) {
    const rows = funnel;
    const columnNames =
      rows.length > 0
        ? [
            ...new Set(
              rows.flatMap((r) =>
                r && typeof r === 'object' ? Object.keys(r) : []
              )
            ),
          ]
        : [];
    return { columnNames, rows };
  }
  const rows = Array.isArray(funnel.rows) ? funnel.rows : [];
  const fromRows = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const fromFields = Array.isArray(funnel.fields) ? funnel.fields : [];
  const columnNames = [
    ...fromFields,
    ...fromRows.filter((k) => !fromFields.includes(k)),
  ];
  return { columnNames, rows };
}

export function getAnthropicMessagesUrl() {
  if (process.env.NODE_ENV === 'development') {
    return '/v1/messages';
  }
  // Production: same-origin proxy (e.g. Vercel `api/messages.js`). Anthropic has no CORS for browsers.
  const proxyPath =
    process.env.REACT_APP_ANTHROPIC_PROXY_PATH || '/api/messages';
  if (/^https?:\/\//i.test(proxyPath)) {
    return proxyPath;
  }
  if (proxyPath) {
    return proxyPath.startsWith('/') ? proxyPath : `/${proxyPath}`;
  }
  const base =
    process.env.REACT_APP_ANTHROPIC_API_URL || 'https://api.anthropic.com';
  return `${base.replace(/\/$/, '')}/v1/messages`;
}

export function loadPijnpuntenCache(reportId) {
  if (!reportId) return null;
  try {
    const raw = localStorage.getItem(LS_PIJN_MAP);
    if (!raw) return null;
    const map = JSON.parse(raw);
    const o = map[reportId];
    if (o?.dataUpdatedAt && typeof o.text === 'string') return o;
  } catch {
    /* ignore */
  }
  return null;
}

export function savePijnpuntenCache(reportId, dataUpdatedAt, text) {
  if (!reportId) return;
  try {
    const raw = localStorage.getItem(LS_PIJN_MAP) || '{}';
    const map = JSON.parse(raw);
    map[reportId] = { dataUpdatedAt, text };
    localStorage.setItem(LS_PIJN_MAP, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function buildPijnpuntenPrompt(payload) {
  return `Je bent senior UX- en productstrateeg voor Therapieland (e-health). Analyseer onderstaande JSON.

- dashboardTitle: naam van dit funnel-dashboard.
- funnelExportRawCsv: ruwe CSV (kan ingekort zijn).
- funnelExport: geparseerde kolommen en rijen.
- featureAdoption: feature-adoptie per onderdeel (indien aanwezig).

${JSON.stringify(payload, null, 2)}

Schrijf in het Nederlands, concreet en actiegericht voor product- en designteams die de flow willen verbeteren. Geen technisch jargon tenzij nodig. Geen inleiding over jezelf of het model.

Gebruik exact deze koppen (##), in deze volgorde:

## Korte samenvatting
(2–4 zinnen: wat gebeurt er in deze flow, en waar zit het grootste verbeterpotentieel?)

## Belangrijkste afhakers in de funnel
(Noem tot drie overgangen tussen opeenvolgende stappen met de sterkste relatieve daling; koppel kort aan mogelijke oorzaak. Als de data onduidelijk is, zeg dat eerlijk en werk met wat je wel ziet.)

## Wat dit waarschijnlijk voor de gebruiker betekent
(Verwarring, twijfel, vertrouwen, tijd, cognitieve belasting, technische frictie — expliciet gekoppeld aan genoemde stappen.)

## Aanbevelingen om de flow te verbeteren
(5–7 genummerde punten: uitvoerbare UX-, copy-, navigatie- of procesaanpassingen; begin met het hoogste verwachte effect.)

## Waar het team mee kan starten
(Max. 3 bullets: eerste concrete stappen deze sprint.)

Totale lengte ongeveer 450–650 woorden.`;
}

export async function fetchPijnpuntenAnalysis(
  { title, report },
  apiKey,
  signal
) {
  const csv = getFunnelCsvText(report);
  const funnelParsed = getFunnelParsedForUi(report);
  const features = getReportFeatures(report);
  const csvForApi =
    csv && csv.length > MAX_CSV_FOR_CLAUDE
      ? `${csv.slice(0, MAX_CSV_FOR_CLAUDE)}\n\n[… export ingekort voor API-limiet …]`
      : csv;
  const payload = {
    dashboardTitle: title || 'Dashboard',
    funnelExportRawCsv: csvForApi || null,
    funnelExport: funnelPayloadForClaude(funnelParsed),
    featureAdoption: features ?? [],
  };
  const prompt = buildPijnpuntenPrompt(payload);

  const res = await fetch(getAnthropicMessagesUrl(), {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      const hint =
        process.env.NODE_ENV === 'development'
          ? 'Controleer REACT_APP_ANTHROPIC_API_KEY in `.env` (geen aanhalingstekens, geen spaties rond `=`). Sla op en herstart `npm start`.'
          : 'Controleer in Vercel → Settings → Environment Variables: `ANTHROPIC_API_KEY` (aanbevolen) of `REACT_APP_ANTHROPIC_API_KEY`. Daarna opnieuw deployen.';
      throw new Error(
        `Anthropic weigerde de aanvraag (401 Unauthorized). ${hint}`
      );
    }
    if (res.status === 429) {
      throw new Error(
        'Te veel verzoeken bij Anthropic (429). Wacht een minuut en ververs daarna de pagina. Als dit blijft gebeuren: sluit andere tabbladen met dit dashboard en controleer of de app niet in een loop nieuwe analyses start.'
      );
    }
    if (res.status === 502 || res.status === 520) {
      throw new Error(
        `De verbinding met Anthropic mislukte (${res.status}). Lokaal: herstart de dev-server na wijzigingen aan setupProxy. Op Vercel: bekijk de logs van de functie \`api/messages\`; controleer netwerk of timeouts.`
      );
    }
    const msg =
      body?.error?.message ||
      `API-fout (${res.status}): ${JSON.stringify(body)}`;
    throw new Error(msg);
  }
  const text =
    body?.content?.[0]?.type === 'text'
      ? body.content[0].text
      : body?.content?.map?.((c) => c.text).filter(Boolean).join('\n') || '';
  if (!text) throw new Error('Geen tekst in het API-antwoord.');
  return text;
}
