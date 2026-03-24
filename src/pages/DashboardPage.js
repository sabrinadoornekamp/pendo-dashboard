import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  deriveFunnelFlowMetrics,
  fetchPijnpuntenAnalysis,
  getReportFeatures,
  groupReportsByFlowGroup,
  hasDashboardData,
  loadPijnpuntenCache,
  loadReport,
  loadReportsStore,
  normalizeFunnelTableForReport,
  pickDefaultReportId,
  resolveEffectiveReportId,
  savePijnpuntenCache,
} from '../lib/flowData';
import {
  insightSectionSlug,
  parseInsightBodyToBlocks,
  splitMarkdownH2Sections,
} from '../lib/insightMarkdown';
import {
  listImagesForReport,
  subscribeReportImagesChanged,
} from '../lib/reportImagesDb';
import {
  countSubstantiveSections,
  extractHeroOpportunity,
  getAnalysisSummaryText,
} from '../lib/dashboardNarrative';
import {
  IconAlert,
  IconBolt,
  IconCheckCircle,
  IconLayers,
  IconTarget,
  IconTrendDown,
  IconUsers,
} from '../components/DashboardIcons';

const STORAGE_KEYS = ['tl_userflow_reports', 'tl_userflow_pijnpunten_by_report'];

/** Grote funnel-CSV: te veel DOM-knoten blokkeert de browser; toon eerste N rijen. */
const MAX_VISIBLE_FUNNEL_ROWS = 800;

function reportHasFunnelForParse(r) {
  if (!r) return false;
  if (r.funnelCsvZ) return true;
  if (r.funnel) return true;
  return false;
}

function formatUpdatedAt(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('nl-NL', {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return iso;
  }
}

function formatCellValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('nl-NL', {
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n.toFixed(digits).replace('.', ',');
  return `${s} %`;
}

function truncateLabel(s, max = 28) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

function funnelMetricsDisclaimer(reason) {
  switch (reason) {
    case 'no_users_column':
      return 'Voor automatische KPI’s en de funnelgrafiek is een kolom met gebruikersaantallen nodig (bijv. “users”, “count”, “visitors”). Controleer de exportkolommen.';
    case 'too_few_steps':
      return 'Er zijn minder dan twee stappen met geldige aantallen. Voeg meerdere funnelstappen toe in de export om doorstroming te tonen.';
    case 'no_data':
      return null;
    default:
      return null;
  }
}

function HeroBodyParagraphs({ text }) {
  if (!text) return null;
  const parts = String(text)
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((p, i) => (
    <p key={i} className="tl-hero-opp__para">
      {p}
    </p>
  ));
}

function InsightBodyBlocks({ body }) {
  const blocks = useMemo(() => parseInsightBodyToBlocks(body), [body]);
  return (
    <div className="insight-body">
      {blocks.map((b, i) => {
        if (b.type === 'p') {
          return (
            <p key={i} className="insight-p">
              {b.text}
            </p>
          );
        }
        if (b.type === 'ul') {
          return (
            <ul key={i} className="insight-ul">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        if (b.type === 'ol') {
          return (
            <ol key={i} className="insight-ol">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ol>
          );
        }
        return null;
      })}
    </div>
  );
}

export default function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [storeRev, setStoreRev] = useState(0);

  const paramId = searchParams.get('report') || '';

  const storeSnapshot = loadReportsStore();

  const reports = [...storeSnapshot.reports].sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );

  const reportSidebarGroups = useMemo(
    () => groupReportsByFlowGroup(reports),
    [reports]
  );

  const effectiveReportId = resolveEffectiveReportId(
    storeSnapshot,
    paramId
  );

  const report = effectiveReportId
    ? storeSnapshot.reports.find((r) => r.id === effectiveReportId) ?? null
    : null;

  const updatedAt = report?.updatedAt ?? null;
  const title = report?.title ?? '';

  /** Bust useMemo wanneer store of rapportdatum wijzigt (zonder `report`-objectref in deps). */
  const reportDataKey = `${effectiveReportId ?? ''}\u0001${updatedAt ?? ''}\u0001${storeRev}`;

  const hasDataStable = useMemo(() => {
    const [id] = reportDataKey.split('\u0001');
    if (!id) return false;
    const r = loadReport(id);
    return r ? hasDashboardData(r) : false;
  }, [reportDataKey]);

  const features = useMemo(() => {
    const [id] = reportDataKey.split('\u0001');
    if (!id) return null;
    const r = loadReport(id);
    return r ? getReportFeatures(r) : null;
  }, [reportDataKey]);

  const [funnelTable, setFunnelTable] = useState(null);
  const [funnelTablePending, setFunnelTablePending] = useState(false);

  const [pijnpunten, setPijnpunten] = useState('');
  const [pijnpuntenLoading, setPijnpuntenLoading] = useState(false);
  const [pijnpuntenError, setPijnpuntenError] = useState(null);
  const requestEpoch = useRef(0);

  const [reportImages, setReportImages] = useState([]);
  const [reportImagesRev, setReportImagesRev] = useState(0);
  const reportImageUrlsRef = useRef([]);
  const effectiveReportIdRef = useRef(effectiveReportId);
  effectiveReportIdRef.current = effectiveReportId;

  const apiKey = (process.env.REACT_APP_ANTHROPIC_API_KEY || '').trim();
  const hasData = hasDataStable;

  const flowMetrics = useMemo(() => {
    if (!funnelTable?.rows?.length) return null;
    return deriveFunnelFlowMetrics(funnelTable);
  }, [funnelTable]);

  const featureSummary = useMemo(() => {
    if (!features?.length) return null;
    const sorted = [...features].sort((a, b) => a.adoption - b.adoption);
    const avg =
      features.reduce((sum, f) => sum + f.adoption, 0) / features.length;
    return {
      lowest: sorted[0],
      highest: sorted[sorted.length - 1],
      avg,
      count: features.length,
    };
  }, [features]);

  const funnelChartData = useMemo(() => {
    if (!flowMetrics?.ok || !flowMetrics.steps?.length) return [];
    return flowMetrics.steps.map((s, idx) => ({
      key: `s-${idx}`,
      shortLabel: truncateLabel(s.label, 22),
      fullLabel: s.label,
      users: s.users,
      retention: s.retentionFromStart,
    }));
  }, [flowMetrics]);

  const pijnpuntenSections = useMemo(
    () => splitMarkdownH2Sections(pijnpunten),
    [pijnpunten]
  );

  const analysisSummary = useMemo(
    () => getAnalysisSummaryText(pijnpuntenSections),
    [pijnpuntenSections]
  );

  const heroOpportunity = useMemo(
    () =>
      extractHeroOpportunity(
        pijnpuntenSections,
        flowMetrics?.ok ? flowMetrics.topDrops?.[0] : null
      ),
    [pijnpuntenSections, flowMetrics]
  );

  const substantiveSectionCount = useMemo(
    () => countSubstantiveSections(pijnpuntenSections),
    [pijnpuntenSections]
  );

  const [dashTab, setDashTab] = useState('inzicht');

  useEffect(() => {
    setDashTab('inzicht');
  }, [effectiveReportId]);

  useEffect(() => {
    if (paramId && storeSnapshot.reports.some((r) => r.id === paramId)) return;
    const def = pickDefaultReportId(storeSnapshot);
    if (def) setSearchParams({ report: def }, { replace: true });
  }, [paramId, setSearchParams, storeSnapshot]);

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key && STORAGE_KEYS.includes(e.key)) {
        setStoreRev((x) => x + 1);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    return subscribeReportImagesChanged((rid) => {
      if (rid === effectiveReportIdRef.current) {
        setReportImagesRev((x) => x + 1);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revokeAll = () => {
      reportImageUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      reportImageUrlsRef.current = [];
    };

    revokeAll();
    if (!effectiveReportId) {
      setReportImages([]);
      return () => {
        cancelled = true;
        revokeAll();
      };
    }

    (async () => {
      try {
        const rows = await listImagesForReport(effectiveReportId);
        if (cancelled) return;
        revokeAll();
        const urls = [];
        const next = rows.map((row) => {
          const url = URL.createObjectURL(row.blob);
          urls.push(url);
          return { id: row.id, url, fileName: row.fileName };
        });
        reportImageUrlsRef.current = urls;
        setReportImages(next);
      } catch {
        if (!cancelled) {
          revokeAll();
          setReportImages([]);
        }
      }
    })();

    return () => {
      cancelled = true;
      revokeAll();
    };
  }, [effectiveReportId, storeRev, reportImagesRev]);

  /* Zware funnel-parse (decompress + Papa) na eerste paint, zodat header/nav direct zichtbaar zijn. */
  useEffect(() => {
    if (!effectiveReportId || !hasData) {
      setFunnelTable(null);
      setFunnelTablePending(false);
      return;
    }

    const currentSnap = loadReport(effectiveReportId);
    if (!currentSnap || !reportHasFunnelForParse(currentSnap)) {
      setFunnelTable(null);
      setFunnelTablePending(false);
      return;
    }

    const rid = effectiveReportId;
    setFunnelTable(null);
    setFunnelTablePending(true);
    const id = window.setTimeout(() => {
      const current = loadReport(rid);
      if (!current || !reportHasFunnelForParse(current)) {
        setFunnelTablePending(false);
        return;
      }
      try {
        setFunnelTable(normalizeFunnelTableForReport(current));
      } finally {
        setFunnelTablePending(false);
      }
    }, 0);

    return () => {
      window.clearTimeout(id);
    };
  }, [effectiveReportId, hasData, updatedAt, storeRev]);

  useEffect(() => {
    const reportId = effectiveReportId;
    if (!reportId) {
      setPijnpunten('');
      setPijnpuntenError(null);
      setPijnpuntenLoading(false);
      return;
    }

    if (!hasData) {
      setPijnpunten('');
      setPijnpuntenError(null);
      setPijnpuntenLoading(false);
      return;
    }

    if (!apiKey) {
      setPijnpunten('');
      setPijnpuntenError(
        'Pijnpunten-analyse is nu niet beschikbaar (API-sleutel ontbreekt). Neem contact op met het team.'
      );
      setPijnpuntenLoading(false);
      return;
    }

    const latest = loadReport(reportId);
    if (!latest) {
      setPijnpuntenLoading(false);
      return;
    }

    const latestUpdatedAt = latest.updatedAt;

    const cached = loadPijnpuntenCache(reportId);
    if (cached?.dataUpdatedAt === latestUpdatedAt && cached.text) {
      setPijnpunten(cached.text);
      setPijnpuntenError(null);
      setPijnpuntenLoading(false);
      return;
    }

    const ac = new AbortController();
    const epoch = ++requestEpoch.current;
    setPijnpuntenLoading(true);
    setPijnpuntenError(null);
    setPijnpunten('');

    fetchPijnpuntenAnalysis(
      { title: latest.title, report: latest },
      apiKey,
      ac.signal
    )
      .then((text) => {
        if (epoch !== requestEpoch.current) return;
        setPijnpunten(text);
        savePijnpuntenCache(reportId, latestUpdatedAt, text);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        if (epoch !== requestEpoch.current) return;
        setPijnpuntenError(err.message || 'Analyse mislukt.');
      })
      .finally(() => {
        if (epoch !== requestEpoch.current) return;
        setPijnpuntenLoading(false);
      });

    return () => ac.abort();
  }, [effectiveReportId, hasData, apiKey, updatedAt, storeRev]);

  if (reports.length === 0) {
    return (
      <div className="page" data-store-rev={storeRev}>
        <header className="page__header page__header--dashboard">
          <h1 className="brand-title">Therapieland User Flow Insights</h1>
          <p className="page__lede page__lede--muted">
            Nog geen data beschikbaar. Zodra een analist de funnel- en/of
            feature-data heeft geüpload, verschijnt het overzicht hier.
          </p>
        </header>
        <section className="panel panel--empty">
          <p className="empty-state__text">
            Nog geen data beschikbaar
          </p>
          <p className="empty-state__hint">
            Het team kan nieuwe exports plaatsen via de beveiligde uploadpagina.
          </p>
        </section>
        <p className="page__footer-note">
          <Link to="/upload" className="text-link">
            Naar upload (analisten)
          </Link>
        </p>
      </div>
    );
  }

  const funnelRows = funnelTable?.rows ?? [];
  const funnelColumns = funnelTable?.columns ?? [];
  const funnelVisibleRows = funnelRows.slice(0, MAX_VISIBLE_FUNNEL_ROWS);
  const funnelHiddenCount = Math.max(0, funnelRows.length - funnelVisibleRows.length);

  const renderFunnelVolumeBlock = (sectionClass) => {
    if (!flowMetrics?.ok || !funnelChartData.length) return null;
    return (
      <section className={sectionClass}>
        <h2 className="tl-card__title panel__title">Volume en behoud per stap</h2>
        <p className="panel__hint">
          Balken: gebruikers per stap. Lijn: percentage van het startvolume dat elke
          stap nog bereikt.
        </p>
        <div className="chart-wrap chart-wrap--funnel-flow">
          <ResponsiveContainer
            width="100%"
            height={Math.min(520, 140 + funnelChartData.length * 42)}
          >
            <ComposedChart
              key={`funnel-chart-${effectiveReportId}-${funnelChartData.length}`}
              data={funnelChartData}
              margin={{ top: 12, right: 28, left: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="key"
                type="category"
                tick={{ fontSize: 10, fill: '#4b5563' }}
                interval={0}
                angle={-30}
                textAnchor="end"
                height={78}
                tickFormatter={(val) => {
                  const row = funnelChartData.find((d) => d.key === val);
                  return row?.shortLabel ?? String(val);
                }}
              />
              <YAxis
                yAxisId="users"
                width={52}
                tick={{ fontSize: 11, fill: '#374151' }}
                tickFormatter={(v) => fmtInt(v)}
              />
              <YAxis
                yAxisId="pct"
                orientation="right"
                width={44}
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: '#9a3412' }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid #e5e7eb',
                }}
                labelFormatter={(_, payload) =>
                  payload?.[0]?.payload?.fullLabel ?? ''
                }
                formatter={(value, name) => {
                  if (name === 'Gebruikers') return [fmtInt(value), name];
                  if (name === 'Behoud t.o.v. start') {
                    return [fmtPct(value, 1), name];
                  }
                  return [value, name];
                }}
              />
              <Legend wrapperStyle={{ paddingTop: 6 }} />
              <Bar
                yAxisId="users"
                dataKey="users"
                name="Gebruikers"
                fill="#0f766e"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="retention"
                name="Behoud t.o.v. start"
                stroke="#c2410c"
                strokeWidth={2}
                dot={{ r: 3, fill: '#c2410c' }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="panel__micro">
          Afgeleid uit “{truncateLabel(flowMetrics.stepColumn, 48)}” (stap) en “
          {truncateLabel(flowMetrics.usersColumn, 48)}” (volume).
        </p>
      </section>
    );
  };

  return (
    <div className="tl-dashboard" data-store-rev={storeRev}>
      <aside className="tl-sidebar">
        <div className="tl-sidebar__brand">
          <span className="tl-sidebar__brand-title">Therapieland</span>
          <span className="tl-sidebar__brand-tag">User Flow Insights</span>
        </div>
        <nav className="tl-sidebar__nav" aria-label="Dashboards">
          {reportSidebarGroups.map((grp) => (
            <div key={grp.groupId} className="tl-sidebar__group">
              <p className="tl-sidebar__section-label">{grp.label}</p>
              {grp.reports.map((r, i) => {
                const active = r.id === effectiveReportId;
                return (
                  <Link
                    key={r.id}
                    to={`/?report=${encodeURIComponent(r.id)}`}
                    className={`tl-sidebar__link${active ? ' tl-sidebar__link--active' : ''}`}
                  >
                    <span className="tl-sidebar__link-num">{i + 1}</span>
                    <span className="tl-sidebar__link-text">{r.title}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="tl-sidebar__footer">
          <Link
            to={
              effectiveReportId
                ? `/upload?report=${encodeURIComponent(effectiveReportId)}`
                : '/upload'
            }
            className="tl-sidebar__footer-link"
          >
            Data bijwerken
          </Link>
          {flowMetrics?.ok && (
            <p className="tl-sidebar__stat">
              <strong>{fmtInt(flowMetrics.firstUsers)}</strong>
              <span>bezoekers gestart (funnel)</span>
            </p>
          )}
          {updatedAt && (
            <p className="tl-sidebar__updated">
              {formatUpdatedAt(updatedAt)}
            </p>
          )}
        </div>
      </aside>

      <div className="tl-dashboard__main">
      {report && !hasData && (
        <section className="panel panel--empty panel--soft tl-main-panel">
          <p className="empty-state__text">{title}</p>
          <p className="empty-state__hint">
            Dit dashboard heeft nog geen funnel- of featuredata. Upload CSV’s
            via de analistpagina om dit scherm te vullen.
          </p>
          <p className="page__footer-note page__footer-note--tight">
            <Link
              to={`/upload?report=${encodeURIComponent(report.id)}`}
              className="text-link"
            >
              Data uploaden voor dit dashboard
            </Link>
          </p>
        </section>
      )}

      {report && hasData && (
        <>
          <div className="tl-main-inner">
            <header className="tl-main-header">
              <h1 className="tl-main-title">{title}</h1>
              <p className="tl-main-subtitle">
                Eén overzicht voor doorstroming, adoptie en concrete
                verbeterpunten — met de helderheid van een professioneel
                analytics-dashboard, aangedreven door jullie export en AI.
              </p>
              <div
                className="tl-tabs"
                role="tablist"
                aria-label="Dashboardweergave"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={dashTab === 'inzicht'}
                  className={`tl-tab${dashTab === 'inzicht' ? ' tl-tab--active' : ''}`}
                  onClick={() => setDashTab('inzicht')}
                >
                  Samengevat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={dashTab === 'funnel'}
                  className={`tl-tab${dashTab === 'funnel' ? ' tl-tab--active' : ''}`}
                  onClick={() => setDashTab('funnel')}
                >
                  Funnel-detail
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={dashTab === 'features'}
                  className={`tl-tab${dashTab === 'features' ? ' tl-tab--active' : ''}`}
                  onClick={() => setDashTab('features')}
                >
                  Feature-adoptie
                </button>
              </div>
            </header>

            {dashTab === 'inzicht' && (
              <div className="tl-split">
                <div className="tl-split__primary">
                  <section className="tl-card tl-card--analysis">
                    <h2 className="tl-card__eyebrow">Analysesamenvatting</h2>
                    {pijnpuntenLoading ? (
                      <p className="tl-analysis-placeholder">
                        Analyse wordt opgebouwd…
                      </p>
                    ) : analysisSummary ? (
                      <p className="tl-analysis-text">{analysisSummary}</p>
                    ) : pijnpuntenError ? (
                      <p className="error tl-analysis-error">{pijnpuntenError}</p>
                    ) : (
                      <p className="tl-analysis-placeholder">
                        Zodra de AI-analyse klaar is, verschijnt hier een korte
                        leesbare samenvatting van de flow.
                      </p>
                    )}
                    <div className="tl-pills" aria-label="Kerngetallen">
                      {flowMetrics?.ok && (
                        <>
                          <span className="tl-pill">
                            {fmtPct(flowMetrics.overallRetention)} doorstroming
                          </span>
                          <span className="tl-pill">
                            {flowMetrics.stepCount} stappen
                          </span>
                          <span className="tl-pill">
                            {fmtInt(flowMetrics.firstUsers)} gestart
                          </span>
                        </>
                      )}
                      <span className="tl-pill">
                        {pijnpuntenLoading
                          ? 'AI-analyse…'
                          : `${substantiveSectionCount} analyse-secties`}
                      </span>
                    </div>
                  </section>

                  <div className="tl-kpi-row">
                    <div className="tl-kpi">
                      <IconUsers className="tl-kpi__icon tl-kpi__icon--blue" />
                      <span className="tl-kpi__label">Bezoekers gestart</span>
                      <strong className="tl-kpi__value">
                        {flowMetrics?.ok
                          ? fmtInt(flowMetrics.firstUsers)
                          : '—'}
                      </strong>
                      <span className="tl-kpi__hint">
                        Unieke gebruikers op stap 1
                      </span>
                    </div>
                    <div className="tl-kpi">
                      <IconTarget className="tl-kpi__icon tl-kpi__icon--green" />
                      <span className="tl-kpi__label">Doorstroming einde</span>
                      <strong className="tl-kpi__value tl-kpi__value--green">
                        {flowMetrics?.ok
                          ? fmtPct(flowMetrics.overallRetention)
                          : '—'}
                      </strong>
                      <span className="tl-kpi__hint">T.o.v. eerste stap</span>
                    </div>
                    <div className="tl-kpi">
                      <IconTrendDown className="tl-kpi__icon tl-kpi__icon--red" />
                      <span className="tl-kpi__label">Grootste daling</span>
                      <strong className="tl-kpi__value tl-kpi__value--red">
                        {flowMetrics?.ok && flowMetrics.topDrops[0]
                          ? fmtPct(flowMetrics.topDrops[0].dropPct)
                          : '—'}
                      </strong>
                      <span className="tl-kpi__hint">
                        {flowMetrics?.ok && flowMetrics.topDrops[0]
                          ? `${truncateLabel(flowMetrics.topDrops[0].fromLabel, 26)} → vervolg`
                          : 'Funnel met stappen nodig'}
                      </span>
                    </div>
                    <div className="tl-kpi">
                      <IconLayers className="tl-kpi__icon tl-kpi__icon--violet" />
                      <span className="tl-kpi__label">Aandachtspunt</span>
                      <strong className="tl-kpi__value">
                        {featureSummary
                          ? fmtPct(featureSummary.lowest.adoption)
                          : flowMetrics?.ok
                            ? String(flowMetrics.stepCount)
                            : '—'}
                      </strong>
                      <span className="tl-kpi__hint">
                        {featureSummary
                          ? truncateLabel(featureSummary.lowest.feature, 34)
                          : flowMetrics?.ok
                            ? 'Stappen in deze funnel'
                            : 'Laagste feature-adoptie'}
                      </span>
                    </div>
                  </div>

                  {flowMetrics &&
                    !flowMetrics.ok &&
                    funnelMetricsDisclaimer(flowMetrics.reason) && (
                      <p className="tl-inline-hint">
                        {funnelMetricsDisclaimer(flowMetrics.reason)}
                      </p>
                    )}
                  {funnelTablePending && !funnelTable && (
                    <p className="tl-inline-hint">Funnel wordt geladen…</p>
                  )}

                  {heroOpportunity && (
                    <section className="tl-hero-opp" aria-labelledby="tl-hero-title">
                      <div className="tl-hero-opp__head">
                        <IconBolt className="tl-hero-opp__icon" />
                        <h2 id="tl-hero-title" className="tl-hero-opp__title">
                          {heroOpportunity.title}
                        </h2>
                      </div>
                      <HeroBodyParagraphs text={heroOpportunity.body} />
                      {heroOpportunity.impact && (
                        <p className="tl-hero-opp__impact">
                          <strong>Eerste stap voor het team:</strong>{' '}
                          {heroOpportunity.impact}
                        </p>
                      )}
                    </section>
                  )}

                  <div className="tl-sentiment-grid">
                    <div className="tl-sentiment tl-sentiment--positive">
                      <IconCheckCircle className="tl-sentiment__icon" />
                      <div>
                        <h3 className="tl-sentiment__title">Wat goed loopt</h3>
                        <p className="tl-sentiment__text">
                          {featureSummary &&
                          featureSummary.highest.adoption >= 30
                            ? `“${truncateLabel(featureSummary.highest.feature, 46)}” heeft de hoogste adoptie (${fmtPct(featureSummary.highest.adoption)}) — bruikbaar als referentie voor wat wél werkt.`
                            : flowMetrics?.ok
                              ? `Nog ${fmtPct(flowMetrics.overallRetention)} van de starters bereikt de laatste gemeten stap.`
                              : 'Upload funnel- en feature-exports om sterke en zwakke punten naast elkaar te zien.'}
                        </p>
                      </div>
                    </div>
                    <div className="tl-sentiment tl-sentiment--risk">
                      <IconAlert className="tl-sentiment__icon" />
                      <div>
                        <h3 className="tl-sentiment__title">
                          Hoogste prioriteit
                        </h3>
                        <p className="tl-sentiment__text">
                          {flowMetrics?.ok && flowMetrics.topDrops[0]
                            ? `De sterkste relatieve daling zit tussen “${truncateLabel(flowMetrics.topDrops[0].fromLabel, 38)}” en “${truncateLabel(flowMetrics.topDrops[0].toLabel, 38)}” (${fmtPct(flowMetrics.topDrops[0].dropPct)}). Start hier met UX-onderzoek of iteratie.`
                            : featureSummary
                              ? `Laagste adoptie: “${truncateLabel(featureSummary.lowest.feature, 46)}” (${fmtPct(featureSummary.lowest.adoption)}).`
                              : 'Met funneldata verschijnen hier de scherpste afhakers automatisch.'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {renderFunnelVolumeBlock('tl-card tl-card--chart')}

                  {reportImages.length > 0 && (
                    <section className="tl-card tl-card--images">
                      <h2 className="tl-card__title panel__title">
                        Aanvullende beelden
                      </h2>
                      <p className="panel__hint">
                        Visuele context bij de flow en aanbevelingen.
                      </p>
                      <div className="report-image-gallery">
                        {reportImages.map((img) => (
                          <figure
                            key={img.id}
                            className="report-image-gallery__item"
                          >
                            <img
                              src={img.url}
                              alt={img.fileName || 'Bijlage'}
                              loading="lazy"
                            />
                            {img.fileName ? (
                              <figcaption className="report-image-gallery__caption">
                                {img.fileName}
                              </figcaption>
                            ) : null}
                          </figure>
                        ))}
                      </div>
                    </section>
                  )}

                  <details className="tl-card tl-details-ai panel panel--insights panel--pijnpunten">
                    <summary className="tl-details-ai__summary">
                      Volledige AI-analyse (alle secties)
                    </summary>
                    <p className="panel__hint tl-details-ai__hint">
                      Uitgebreide interpretatie per onderdeel — open om alles te
                      lezen.
                    </p>
                    {pijnpuntenLoading && (
                      <p className="panel__status">Analyse wordt opgebouwd…</p>
                    )}
                    {pijnpuntenError && !pijnpuntenLoading && (
                      <p className="error">{pijnpuntenError}</p>
                    )}
                    {pijnpunten &&
                      !pijnpuntenLoading &&
                      pijnpuntenSections.length > 0 && (
                        <div className="insight-sections">
                          {pijnpuntenSections.map((sec, idx) => {
                            const slug = insightSectionSlug(sec.title);
                            const isPriority =
                              slug.includes('starten') ||
                              sec.title.toLowerCase().includes('waar het team');
                            return (
                              <article
                                key={`${slug}-${idx}`}
                                className={`insight-card${isPriority ? ' insight-card--priority' : ''}`}
                              >
                                <h3 className="insight-card__title">
                                  {sec.title}
                                </h3>
                                <InsightBodyBlocks body={sec.body} />
                              </article>
                            );
                          })}
                        </div>
                      )}
                    {pijnpunten &&
                      !pijnpuntenLoading &&
                      pijnpuntenSections.length === 0 && (
                        <div className="pijnpunten-body">
                          <pre className="insight-fallback-pre">{pijnpunten}</pre>
                        </div>
                      )}
                  </details>
                </div>

                <aside className="tl-split__rail" aria-label="Volume per stap">
                  <h3 className="tl-rail__title">Volume per stap</h3>
                  <p className="tl-rail__lede">
                    Relatieve drukte t.o.v. de stap met de meeste gebruikers.
                  </p>
                  {flowMetrics?.ok ? (
                    <>
                      <ul className="tl-rail__list">
                        {flowMetrics.steps.map((s, idx) => {
                          const maxU = Math.max(
                            ...flowMetrics.steps.map((x) => x.users),
                            1
                          );
                          const ratio = s.users / maxU;
                          const tier =
                            ratio >= 0.66 ? 'high' : ratio >= 0.33 ? 'mid' : 'low';
                          return (
                            <li key={idx} className="tl-rail__row">
                              <span className="tl-rail__step-name">
                                {truncateLabel(s.label, 34)}
                              </span>
                              <span
                                className={`tl-rail__badge tl-rail__badge--${tier}`}
                              >
                                {fmtInt(s.users)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="tl-rail__legend">
                        <span>
                          <span
                            className="tl-rail__dot tl-rail__dot--high"
                            aria-hidden
                          />{' '}
                          Hoog
                        </span>
                        <span>
                          <span
                            className="tl-rail__dot tl-rail__dot--mid"
                            aria-hidden
                          />{' '}
                          Midden
                        </span>
                        <span>
                          <span
                            className="tl-rail__dot tl-rail__dot--low"
                            aria-hidden
                          />{' '}
                          Laag
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="tl-rail__empty">
                      Geen funnelvolume om te tonen. Voeg een export toe met
                      gebruikers per stap.
                    </p>
                  )}
                </aside>
              </div>
            )}

            {dashTab === 'funnel' && (
              <>
                {renderFunnelVolumeBlock('panel')}
                {flowMetrics?.ok && flowMetrics.topDrops.length > 0 && (
            <section className="panel panel--drop-cards">
              <h2 className="panel__title">Sterkste dalingen in de flow</h2>
              <p className="panel__hint">
                Relatief de grootste daling tussen twee opeenvolgende stappen —
                vaak de eerste plek om gebruikersinterviews of designiteraties te
                plannen.
              </p>
              <ul className="drop-off-cards">
                {flowMetrics.topDrops.map((t, i) => (
                  <li key={`${t.fromLabel}-${t.toLabel}-${i}`} className="drop-off-card">
                    <span className="drop-off-card__rank">{i + 1}</span>
                    <div className="drop-off-card__body">
                      <p className="drop-off-card__route">
                        <span className="drop-off-card__from">
                          {truncateLabel(t.fromLabel, 40)}
                        </span>
                        <span className="drop-off-card__arrow" aria-hidden>
                          →
                        </span>
                        <span className="drop-off-card__to">
                          {truncateLabel(t.toLabel, 40)}
                        </span>
                      </p>
                      <p className="drop-off-card__stats">
                        <span>
                          {fmtInt(t.fromUsers)} → {fmtInt(t.toUsers)} gebruikers
                        </span>
                        <span className="drop-off-card__pct">
                          {fmtPct(t.dropPct)} minder dan vorige stap
                        </span>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
                )}

            {(funnelTablePending || funnelTable) &&
            funnelTable &&
            funnelVisibleRows.length > 0 && (
              <details className="panel panel--raw-funnel">
                <summary className="raw-funnel-summary">
                  Ruwe funnel-export (volledige tabel)
                </summary>
                <p className="panel__hint">
                  Data exact zoals in de CSV-export. Handig voor audit of export
                  naar spreadsheet.
                </p>
                {funnelHiddenCount > 0 && (
                  <p className="panel__hint panel__hint--warn">
                    Alleen de eerste {MAX_VISIBLE_FUNNEL_ROWS} rijen worden
                    getoond ({funnelHiddenCount} verborgen). Maak de export kleiner
                    voor de volledige tabel in de browser.
                  </p>
                )}
                <div className="table-wrap table-wrap--raw">
                  <table className="data-table data-table--raw">
                    <thead>
                      <tr>
                        {funnelColumns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {funnelVisibleRows.map((row, ri) => (
                        <tr key={ri}>
                          {funnelColumns.map((col) => (
                            <td key={col}>{formatCellValue(row[col])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

              </>
            )}

            {dashTab === 'features' && features?.length > 0 && (
              <section className="panel">
                <h2 className="panel__title">Feature-adoptie</h2>
                <p className="panel__hint">
                  Adoptiepercentage per feature in deze export.
                </p>
                <div className="chart-wrap chart-wrap--features">
                  <ResponsiveContainer
                    width="100%"
                    height={Math.max(260, features.length * 40)}
                  >
                    <BarChart
                      layout="vertical"
                      data={features}
                      margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        type="number"
                        domain={[0, 'auto']}
                        tick={{ fontSize: 12, fill: '#4b5563' }}
                        unit="%"
                      />
                      <YAxis
                        type="category"
                        dataKey="feature"
                        width={148}
                        tick={{ fontSize: 11, fill: '#374151' }}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: 8,
                          border: '1px solid #e5e7eb',
                        }}
                        formatter={(v) => [`${v}%`, 'Adoptie']}
                      />
                      <Bar
                        dataKey="adoption"
                        name="Adoptie %"
                        fill="#0d9488"
                        radius={[0, 4, 4, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}
          </div>
        </>
      )}

      </div>
    </div>
  );
}
