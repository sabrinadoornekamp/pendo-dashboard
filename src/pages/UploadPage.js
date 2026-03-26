import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  REPORT_FLOW_GROUPS,
  createReport,
  listReportsSorted,
  loadReport,
  loadReportsStore,
  persistReportPatch,
  updateReportTitle,
} from '../lib/flowData';
import {
  fetchPendoAggregationForReport,
  fetchPendoFeatures,
  fetchPendoReportCatalog,
  fetchPendoReportDetails,
  fetchPendoReportTable,
  normalizePendoFunnelForReport,
} from '../lib/pendoApi';
import {
  addImagesToReport,
  deleteReportImage,
  listImagesForReport,
  MAX_BYTES_PER_IMAGE,
  MAX_IMAGES_PER_REPORT,
} from '../lib/reportImagesDb';

const UPLOAD_PASSWORD = 'therapieland2025';
const SESSION_KEY = 'tl_analyst_session';
const NEW_VALUE = '__new__';
const LS_PENDO_SYNC = 'tl_userflow_pendo_sync';

const PENDO_KIND_LABEL = {
  funnel: 'Funnel',
  path: 'Pad / journey',
  other: 'Overig',
};

const PENDO_KEY_HINT =
  'Pendo API key ontbreekt. Zet REACT_APP_PENDO_API_KEY in .env en herstart npm start.';
const PENDO_WAIT_ATTEMPTS = 6;
const PENDO_WAIT_MS = 20000;

function getPendoSuitability(entry) {
  const normalized = normalizePendoFunnelForReport(entry?.raw);
  const stepCount = normalized?.rows?.length || 0;
  const name = String(entry?.name || '').toLowerCase();
  const likelyByName =
    /\bfunnel\b|onboard|signup|checkout|flow|journey|path|stap|step/.test(name);
  return {
    normalized,
    stepCount,
    suitable: stepCount >= 2,
    likelyByName,
  };
}

function readSessionUnlocked() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setSessionUnlocked() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* ignore */
  }
}

export default function UploadPage() {
  const [searchParams] = useSearchParams();
  const [unlocked, setUnlocked] = useState(readSessionUnlocked);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState(null);

  const [, setReportsRev] = useState(0);
  const reports = listReportsSorted();
  const reportFromUrl = searchParams.get('report') || '';

  const [selectedKey, setSelectedKey] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newFlowGroup, setNewFlowGroup] = useState('professional');
  const [editTitle, setEditTitle] = useState('');
  const [editFlowGroup, setEditFlowGroup] = useState('general');

  const [pendoCatalogError, setPendoCatalogError] = useState(null);
  const [pendoCatalogNotice, setPendoCatalogNotice] = useState(null);
  const [featureError, setFeatureError] = useState(null);
  const [pendoLinkError, setPendoLinkError] = useState(null);
  const [pendoCatalogLoading, setPendoCatalogLoading] = useState(false);
  const [pendoFeatureLoading, setPendoFeatureLoading] = useState(false);
  const [pendoCatalog, setPendoCatalog] = useState([]);
  const [pendoCatalogLoadedAt, setPendoCatalogLoadedAt] = useState(null);
  const [pendoCatalogSearch, setPendoCatalogSearch] = useState('');
  const [pendoCatalogKind, setPendoCatalogKind] = useState('all');
  const [showOnlySuitable, setShowOnlySuitable] = useState(false);
  const [selectedCatalogId, setSelectedCatalogId] = useState('');
  const [pendoWaitLoading, setPendoWaitLoading] = useState(false);
  const [pendoWaitStatus, setPendoWaitStatus] = useState('');
  const [lastPendoSyncAt, setLastPendoSyncAt] = useState(null);
  const [storageError, setStorageError] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);

  const [imageError, setImageError] = useState(null);
  const [imagesRev, setImagesRev] = useState(0);
  const [imageThumbs, setImageThumbs] = useState([]);
  const imageObjectUrlsRef = useRef([]);

  useEffect(() => {
    if (!unlocked) return;
    if (reportFromUrl && loadReport(reportFromUrl)) {
      const r = loadReport(reportFromUrl);
      setSelectedKey(reportFromUrl);
      setEditTitle(r?.title ?? '');
      setEditFlowGroup(r?.flowGroup ?? 'general');
      return;
    }
    const { lastActiveReportId } = loadReportsStore();
    const list = listReportsSorted();
    if (lastActiveReportId && list.some((r) => r.id === lastActiveReportId)) {
      const r = loadReport(lastActiveReportId);
      setSelectedKey(lastActiveReportId);
      setEditTitle(r?.title ?? '');
      setEditFlowGroup(r?.flowGroup ?? 'general');
      return;
    }
    if (list.length === 1) {
      setSelectedKey(list[0].id);
      setEditTitle(list[0].title);
      setEditFlowGroup(list[0].flowGroup ?? 'general');
    }
  }, [unlocked, reportFromUrl]);

  const bumpReports = useCallback(() => setReportsRev((x) => x + 1), []);
  const bumpImages = useCallback(() => setImagesRev((x) => x + 1), []);

  const activeReportId =
    selectedKey && selectedKey !== NEW_VALUE ? selectedKey : null;
  const pendoApiKey = (process.env.REACT_APP_PENDO_API_KEY || '').trim();
  const pendoDashboardScopeId = (
    process.env.REACT_APP_PENDO_DASHBOARD_ID || ''
  ).trim();

  const analyzedPendoCatalog = useMemo(
    () =>
      pendoCatalog.map((entry) => {
        const suitability = getPendoSuitability(entry);
        return {
          ...entry,
          ...suitability,
        };
      }),
    [pendoCatalog]
  );

  const filteredPendoCatalog = useMemo(() => {
    let rows = analyzedPendoCatalog;
    if (pendoCatalogKind !== 'all') {
      rows = rows.filter((e) => e.kind === pendoCatalogKind);
    }
    if (showOnlySuitable) {
      rows = rows.filter((e) => e.suitable);
    }
    const q = pendoCatalogSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          String(e.id).toLowerCase().includes(q)
      );
    }
    return rows;
  }, [analyzedPendoCatalog, pendoCatalogKind, pendoCatalogSearch, showOnlySuitable]);

  const selectedCatalogEntry = useMemo(
    () => analyzedPendoCatalog.find((e) => e.id === selectedCatalogId) || null,
    [analyzedPendoCatalog, selectedCatalogId]
  );

  const syncTitleWithPendoSelection = useCallback(
    (name) => {
      const title = String(name || '').trim();
      if (!title) return;
      if (selectedKey === NEW_VALUE || !activeReportId) {
        setNewTitle(title);
        return;
      }
      setEditTitle(title);
    },
    [activeReportId, selectedKey]
  );

  const submitPassword = (e) => {
    e.preventDefault();
    setAuthError(null);
    if (password === UPLOAD_PASSWORD) {
      setSessionUnlocked();
      setUnlocked(true);
      setPassword('');
    } else {
      setAuthError('Onjuist wachtwoord.');
    }
  };

  const flashSaved = useCallback((msg) => {
    setSaveMessage(msg);
    setTimeout(() => setSaveMessage(null), 5000);
  }, []);

  const handleSelectChange = (e) => {
    const v = e.target.value;
    setStorageError(null);
    setSelectedKey(v);
    if (v && v !== NEW_VALUE) {
      const r = loadReport(v);
      setEditTitle(r?.title ?? '');
      setEditFlowGroup(r?.flowGroup ?? 'general');
    }
  };

  const handleCreateDashboard = () => {
    setStorageError(null);
    const result = createReport(newTitle, { flowGroup: newFlowGroup });
    if (!result.ok) {
      setStorageError(result.message);
      return;
    }
    const r = result.report;
    setSelectedKey(r.id);
    setEditTitle(r.title);
    setEditFlowGroup(r.flowGroup ?? 'general');
    setNewTitle('');
    bumpReports();
    flashSaved(`Dashboard “${r.title}” aangemaakt.`);
  };

  const handleFlowGroupChange = (e) => {
    const v = e.target.value;
    setEditFlowGroup(v);
    if (!activeReportId) return;
    setStorageError(null);
    const res = persistReportPatch(activeReportId, { flowGroup: v });
    if (!res.ok) {
      setStorageError(res.message);
      return;
    }
    bumpReports();
    flashSaved('Sidebar-groep opgeslagen.');
  };

  const handleSaveTitle = () => {
    if (!activeReportId) return;
    setStorageError(null);
    const res = updateReportTitle(activeReportId, editTitle);
    if (!res.ok) {
      setStorageError(res.message);
      return;
    }
    bumpReports();
    flashSaved('Titel opgeslagen.');
  };

  useEffect(() => {
    if (!activeReportId) {
      setLastPendoSyncAt(null);
      return;
    }
    try {
      const raw = localStorage.getItem(LS_PENDO_SYNC);
      const map = raw ? JSON.parse(raw) : {};
      setLastPendoSyncAt(map?.[activeReportId]?.syncedAt || null);
    } catch {
      setLastPendoSyncAt(null);
    }
  }, [activeReportId, saveMessage]);

  const handleLoadPendoCatalog = useCallback(async () => {
    setPendoCatalogError(null);
    setPendoCatalogNotice(null);
    setPendoLinkError(null);
    if (!pendoApiKey) {
      setPendoCatalogError(PENDO_KEY_HINT);
      return;
    }

    const ac = new AbortController();
    setPendoCatalogLoading(true);
    try {
      const entries = await fetchPendoReportCatalog(pendoApiKey, ac.signal, {
        dashboardId: pendoDashboardScopeId,
      });
      setPendoCatalog(entries);
      const scopeWarning = entries.find((e) => e.scopeWarning)?.scopeWarning || null;
      if (scopeWarning) {
        setPendoCatalogNotice(scopeWarning);
      }
      setPendoCatalogLoadedAt(new Date().toISOString());
      const scored = entries
        .map((e) => ({ entry: e, ...getPendoSuitability(e) }))
        .sort((a, b) => {
          if (a.suitable !== b.suitable) return a.suitable ? -1 : 1;
          if (a.stepCount !== b.stepCount) return b.stepCount - a.stepCount;
          if (a.likelyByName !== b.likelyByName) return a.likelyByName ? -1 : 1;
          return 0;
        });
      const preferred = scored[0]?.entry || entries[0];
      setSelectedCatalogId(preferred?.id || '');
      syncTitleWithPendoSelection(preferred?.name);
      flashSaved(
        `${entries.length} Pendo-rapport(en) geladen. Geschiktste kandidaat is alvast geselecteerd; je kunt altijd handmatig wisselen.`
      );
    } catch (e) {
      setPendoCatalogError(e?.message || 'Rapporten ophalen mislukt.');
    } finally {
      setPendoCatalogLoading(false);
      ac.abort();
    }
  }, [flashSaved, pendoApiKey, pendoDashboardScopeId, syncTitleWithPendoSelection]);

  const handleLoadPendoFeaturesOnly = useCallback(async () => {
    setFeatureError(null);
    setStorageError(null);
    if (!activeReportId) {
      setFeatureError('Selecteer eerst een dashboard.');
      return;
    }
    if (!pendoApiKey) {
      setFeatureError(PENDO_KEY_HINT);
      return;
    }

    const ac = new AbortController();
    setPendoFeatureLoading(true);
    try {
      const { features, usedAdoptionFallback } = await fetchPendoFeatures(
        pendoApiKey,
        ac.signal
      );
      if (!features.length) {
        throw new Error(
          'Geen features ontvangen van Pendo (lege lijst op GET /feature).'
        );
      }
      const saved = persistReportPatch(activeReportId, { features });
      if (!saved.ok) {
        throw new Error(saved.message || 'Opslaan mislukt.');
      }
      bumpReports();
      flashSaved(
        usedAdoptionFallback
          ? 'Featurelijst opgeslagen. Let op: geen adoptiepercentages in GET /feature; tijdelijk 0%.'
          : 'Feature-adoptie opgeslagen op dit dashboard.'
      );
    } catch (e) {
      setFeatureError(e?.message || 'Features ophalen mislukt.');
    } finally {
      setPendoFeatureLoading(false);
      ac.abort();
    }
  }, [activeReportId, bumpReports, flashSaved, pendoApiKey]);

  const persistPendoFunnelForDashboard = useCallback(
    (entry, normalizedFunnelOverride) => {
      if (!activeReportId) {
        setPendoLinkError('Selecteer eerst een dashboard.');
        return false;
      }
      if (!entry) {
        setPendoLinkError('Geen rapport geselecteerd.');
        return false;
      }
      setPendoLinkError(null);
      setStorageError(null);
      const normalizedFunnel =
        normalizedFunnelOverride ||
        entry.normalized ||
        normalizePendoFunnelForReport(entry.raw);
      if (!normalizedFunnel) {
        const alternatives = analyzedPendoCatalog
          .filter((e) => e.suitable && e.id !== entry.id)
          .slice(0, 3)
          .map((e) => `“${e.name}”`)
          .join(', ');
        setPendoLinkError(
          alternatives
            ? `Dit rapport heeft nu geen stap-volumes vanuit Pendo. Probeer: ${alternatives}.`
            : 'Dit rapport heeft geen bruikbare funnel-stappen of tabelrijen vanuit Pendo. Ververs in Pendo zelf, wacht kort en haal daarna hier opnieuw rapporten op.'
        );
        return false;
      }
      const res = persistReportPatch(activeReportId, { funnel: normalizedFunnel });
      if (!res.ok) {
        setPendoLinkError(res.message || 'Opslaan mislukt.');
        return false;
      }
      const syncedAt = new Date().toISOString();
      try {
        const raw = localStorage.getItem(LS_PENDO_SYNC);
        const map = raw ? JSON.parse(raw) : {};
        map[activeReportId] = {
          syncedAt,
          funnelId: entry.id,
          funnelName: entry.name,
          reportKind: entry.kind,
        };
        localStorage.setItem(LS_PENDO_SYNC, JSON.stringify(map));
      } catch {
        /* ignore */
      }
      setLastPendoSyncAt(syncedAt);
      bumpReports();
      flashSaved(`Funnel op dashboard: “${entry.name}”.`);
      return true;
    },
    [activeReportId, analyzedPendoCatalog, bumpReports, flashSaved]
  );

  const getNormalizedFunnelFromEntry = useCallback(
    async (entry) => {
      const fromCatalog = entry?.normalized || normalizePendoFunnelForReport(entry?.raw);
      if (fromCatalog) return fromCatalog;
      if (!entry?.id || !pendoApiKey) return null;
      const ac = new AbortController();
      const details = await fetchPendoReportDetails(entry.id, pendoApiKey, ac.signal);
      const mergedRaw = {
        ...(entry.raw || {}),
        report: details,
        results: details?.results || entry.raw?.results,
        data: details?.data || entry.raw?.data,
        rows: details?.rows || entry.raw?.rows,
        steps: details?.steps || entry.raw?.steps,
      };
      const fromDetails = normalizePendoFunnelForReport(mergedRaw);
      if (fromDetails) return fromDetails;

      let aggregationDebug = null;
      const aggregationFallback = await fetchPendoAggregationForReport(
        mergedRaw,
        pendoApiKey,
        ac.signal
      );
      if (!aggregationFallback?.data) {
        aggregationDebug = aggregationFallback?.debug || null;
      } else {
        const aggregationResult = aggregationFallback.data;
        const fromAggregation = normalizePendoFunnelForReport({
          ...mergedRaw,
          aggregationResult,
          data: aggregationResult?.data || mergedRaw.data,
          results: aggregationResult?.results || mergedRaw.results,
          rows: aggregationResult?.rows || mergedRaw.rows,
        });
        if (fromAggregation) return fromAggregation;
      }

      const genericTable = await fetchPendoReportTable(
        entry.id,
        mergedRaw,
        pendoApiKey,
        ac.signal
      );
      if (genericTable?.rows?.length) {
        return genericTable;
      }
      if (aggregationDebug) {
        throw new Error(
          `${aggregationDebug} Ook geen bruikbare tabeldata in dit rapport gevonden.`
        );
      }
      return null;
    },
    [pendoApiKey]
  );

  const handleApplySelectedReportToDashboard = useCallback(async () => {
    const entry = analyzedPendoCatalog.find((e) => e.id === selectedCatalogId);
    if (!entry) return;
    try {
      const normalized = await getNormalizedFunnelFromEntry(entry);
      persistPendoFunnelForDashboard(entry, normalized);
    } catch (e) {
      setPendoLinkError(e?.message || 'Rapportdetail ophalen uit Pendo mislukte.');
    }
  }, [
    analyzedPendoCatalog,
    getNormalizedFunnelFromEntry,
    persistPendoFunnelForDashboard,
    selectedCatalogId,
  ]);

  const handleWaitForPendoRefresh = useCallback(async () => {
    setPendoCatalogError(null);
    setPendoLinkError(null);
    setPendoWaitStatus('');
    if (!activeReportId) {
      setPendoLinkError('Selecteer eerst een dashboard.');
      return;
    }
    if (!pendoApiKey) {
      setPendoLinkError(PENDO_KEY_HINT);
      return;
    }
    if (!selectedCatalogEntry) {
      setPendoLinkError('Selecteer eerst een Pendo-rapport.');
      return;
    }

    setPendoWaitLoading(true);
    const targetId = selectedCatalogEntry.id;
    const targetName = selectedCatalogEntry.name;

    try {
      for (let i = 1; i <= PENDO_WAIT_ATTEMPTS; i += 1) {
        setPendoWaitStatus(
          `Wachten op Pendo-refresh… poging ${i}/${PENDO_WAIT_ATTEMPTS}`
        );

        const ac = new AbortController();
        const entries = await fetchPendoReportCatalog(pendoApiKey, ac.signal, {
          dashboardId: pendoDashboardScopeId,
        });
        const analyzed = entries.map((e) => ({ ...e, ...getPendoSuitability(e) }));
        setPendoCatalog(entries);

        const refreshed =
          analyzed.find((e) => e.id === targetId) ||
          analyzed.find((e) => e.name === targetName) ||
          null;
        if (refreshed) {
          setSelectedCatalogId(refreshed.id);
          // eslint-disable-next-line no-await-in-loop
          const normalized = await getNormalizedFunnelFromEntry(refreshed);
          const ok = persistPendoFunnelForDashboard(refreshed, normalized);
          if (ok) {
            setPendoWaitStatus(`Volumes beschikbaar na ${i} poging(en).`);
            return;
          }
        }
        if (i < PENDO_WAIT_ATTEMPTS) {
          await sleep(PENDO_WAIT_MS);
        }
      }

      setPendoLinkError(
        `Na ${PENDO_WAIT_ATTEMPTS} pogingen zijn nog geen stap-volumes beschikbaar. Probeer later opnieuw of gebruik Pendo Aggregation API.`
      );
    } catch (e) {
      setPendoLinkError(e?.message || 'Automatisch verversen vanuit Pendo mislukte.');
    } finally {
      setPendoWaitLoading(false);
    }
  }, [
    activeReportId,
    getNormalizedFunnelFromEntry,
    pendoApiKey,
    pendoDashboardScopeId,
    persistPendoFunnelForDashboard,
    selectedCatalogEntry,
  ]);

  const handleSelectedCatalogIdChange = useCallback(
    (id) => {
      setSelectedCatalogId(id);
      const entry = analyzedPendoCatalog.find((e) => e.id === id);
      syncTitleWithPendoSelection(entry?.name);
    },
    [analyzedPendoCatalog, syncTitleWithPendoSelection]
  );

  /** Snelkoppeling: catalog ophalen (indien leeg), features ophalen, geselecteerd rapport als rapportdata. */
  const handlePendoSyncAll = useCallback(async () => {
    setPendoCatalogError(null);
    setFeatureError(null);
    setPendoLinkError(null);
    setStorageError(null);
    if (!activeReportId) {
      setPendoLinkError('Selecteer eerst een dashboard.');
      return;
    }
    if (!pendoApiKey) {
      setPendoLinkError(PENDO_KEY_HINT);
      return;
    }

    const ac = new AbortController();
    setPendoCatalogLoading(true);
    setPendoFeatureLoading(true);
    try {
      let catalog = analyzedPendoCatalog;
      if (!catalog.length) {
        const entries = await fetchPendoReportCatalog(pendoApiKey, ac.signal, {
          dashboardId: pendoDashboardScopeId,
        });
        setPendoCatalog(entries);
        catalog = entries.map((e) => ({ ...e, ...getPendoSuitability(e) }));
        setPendoCatalogLoadedAt(new Date().toISOString());
      }
      const pickId =
        selectedCatalogId && catalog.some((c) => c.id === selectedCatalogId)
          ? selectedCatalogId
          : (
              catalog.find((c) => c.suitable) ||
              catalog.find((c) => c.kind === 'funnel' || c.kind === 'path') ||
              catalog[0]
            ).id;
      setSelectedCatalogId(pickId);
      const entry = catalog.find((c) => c.id === pickId);
      if (!entry) throw new Error('Geen rapport om te koppelen.');
      syncTitleWithPendoSelection(entry.name);

      const normalizedFunnel = await getNormalizedFunnelFromEntry(entry);
      if (!normalizedFunnel) {
        throw new Error(
          'Geselecteerd rapport heeft geen bruikbare funnel-stappen. Kies handmatig een ander rapport.'
        );
      }

      const { features, usedAdoptionFallback } = await fetchPendoFeatures(
        pendoApiKey,
        ac.signal
      );
      if (!features.length) {
        throw new Error('Geen features van Pendo ontvangen.');
      }

      const saved = persistReportPatch(activeReportId, {
        funnel: normalizedFunnel,
        features,
      });
      if (!saved.ok) {
        throw new Error(saved.message || 'Opslaan mislukt.');
      }
      const syncedAt = new Date().toISOString();
      try {
        const raw = localStorage.getItem(LS_PENDO_SYNC);
        const map = raw ? JSON.parse(raw) : {};
        map[activeReportId] = {
          syncedAt,
          funnelId: entry.id,
          funnelName: entry.name,
          reportKind: entry.kind,
        };
        localStorage.setItem(LS_PENDO_SYNC, JSON.stringify(map));
      } catch {
        /* ignore */
      }
      setLastPendoSyncAt(syncedAt);
      bumpReports();
      flashSaved(
        usedAdoptionFallback
          ? 'Funnel + features opgeslagen. Let op: feature-adoptie mogelijk 0% (zie GET /feature).'
          : 'Funnel + features opgeslagen op dit dashboard.'
      );
    } catch (e) {
      setPendoLinkError(e?.message || 'Synchroniseren mislukt.');
    } finally {
      setPendoCatalogLoading(false);
      setPendoFeatureLoading(false);
      ac.abort();
    }
  }, [
    activeReportId,
    analyzedPendoCatalog,
    bumpReports,
    flashSaved,
    getNormalizedFunnelFromEntry,
    pendoApiKey,
    pendoDashboardScopeId,
    selectedCatalogId,
    syncTitleWithPendoSelection,
  ]);

  useEffect(() => {
    let cancelled = false;
    const revokePrev = () => {
      imageObjectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      imageObjectUrlsRef.current = [];
    };

    if (!activeReportId) {
      revokePrev();
      setImageThumbs([]);
      return undefined;
    }

    (async () => {
      try {
        const rows = await listImagesForReport(activeReportId);
        if (cancelled) return;
        revokePrev();
        const next = rows.map((row) => {
          const url = URL.createObjectURL(row.blob);
          imageObjectUrlsRef.current.push(url);
          return { id: row.id, fileName: row.fileName, url };
        });
        setImageThumbs(next);
      } catch {
        if (!cancelled) {
          revokePrev();
          setImageThumbs([]);
          setImageError('Afbeeldingen konden niet worden geladen.');
        }
      }
    })();

    return () => {
      cancelled = true;
      revokePrev();
    };
  }, [activeReportId, imagesRev]);

  const handleImageFiles = useCallback(
    async (fileList) => {
      setImageError(null);
      setStorageError(null);
      if (!activeReportId) {
        setImageError('Selecteer of maak eerst een dashboard met een titel.');
        return;
      }
      const files = Array.from(fileList || []).filter(Boolean);
      if (!files.length) return;
      try {
        await addImagesToReport(activeReportId, files);
        bumpImages();
        flashSaved(
          files.length === 1
            ? 'Afbeelding opgeslagen.'
            : `${files.length} afbeeldingen opgeslagen.`
        );
      } catch (e) {
        setImageError(e?.message || 'Afbeeldingen konden niet worden opgeslagen.');
      }
    },
    [activeReportId, bumpImages, flashSaved]
  );

  const handleDeleteImage = useCallback(
    async (imageId) => {
      setImageError(null);
      try {
        await deleteReportImage(imageId);
        bumpImages();
        flashSaved('Afbeelding verwijderd.');
      } catch (e) {
        setImageError(e?.message || 'Verwijderen mislukt.');
      }
    },
    [bumpImages, flashSaved]
  );

  if (!unlocked) {
    return (
      <div className="page page--narrow">
        <header className="page__header">
          <h1 className="brand-title">Therapieland User Flow Insights</h1>
          <p className="page__lede">Analistomgeving — log in om data te uploaden.</p>
        </header>
        <section className="panel">
          <h2 className="panel__title">Toegang uploadpagina</h2>
          <form className="auth-form" onSubmit={submitPassword}>
            <label className="field-label" htmlFor="upload-pw">
              Wachtwoord
            </label>
            <input
              id="upload-pw"
              className="text-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            {authError && <p className="error">{authError}</p>}
            <button type="submit" className="btn btn--primary">
              Ga verder
            </button>
          </form>
        </section>
        <p className="page__footer-note">
          <Link to="/" className="text-link">
            Terug naar dashboard
          </Link>
          {' · '}
          <Link to="/changelog" className="text-link">
            Changelog
          </Link>
        </p>
      </div>
    );
  }

  const dashboardHref =
    activeReportId != null
      ? `/?report=${encodeURIComponent(activeReportId)}`
      : '/';

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="brand-title">Therapieland User Flow Insights</h1>
        <p className="page__lede">
          Kies een bestaand dashboard om bij te werken, of maak een nieuw dashboard
          met een eigen titel. Uploads worden aan dat dashboard gekoppeld.
        </p>
      </header>

      {storageError && (
        <div className="banner banner--error" role="alert">
          {storageError}
        </div>
      )}

      {saveMessage && (
        <div className="banner banner--success" role="status">
          {saveMessage}
        </div>
      )}

      <section className="panel">
        <h2 className="panel__title">Pendo — data koppelen</h2>
        <p className="panel__hint">
          Werk in drie stappen: (1) haal het <strong>rapportcatalogus</strong> op uit
          Pendo (<code className="inline-code">GET /report</code> —{' '}
          <code className="inline-code">GET /funnel</code> bestaat op EU niet), (2){' '}
          <strong>kies</strong> welk rapport de data op <em>dit</em> dashboard
          voedt, (3) haal <strong>feature-adoptie</strong> apart op indien nodig (
          <code className="inline-code">GET /feature</code>). Zo bepaal je zelf wat
          waar getoond wordt.
        </p>
        {pendoDashboardScopeId && (
          <p className="panel__status">
            Dashboard-scope actief: alleen rapporten gekoppeld aan dashboard-ID{' '}
            <code className="inline-code">{pendoDashboardScopeId}</code>.
          </p>
        )}

        <div className="pendo-toolbar">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={handleLoadPendoCatalog}
            disabled={pendoCatalogLoading}
          >
            {pendoCatalogLoading ? 'Rapporten laden…' : '1. Rapporten ophalen'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={handleLoadPendoFeaturesOnly}
            disabled={pendoFeatureLoading || !activeReportId}
          >
            {pendoFeatureLoading ? 'Features laden…' : '2. Feature-adoptie ophalen'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handlePendoSyncAll}
            disabled={
              pendoCatalogLoading ||
              pendoFeatureLoading ||
              !activeReportId
            }
            title="Haalt indien nodig de catalogus op, daarna features, en zet het gekozen rapport als dashboarddata."
          >
            Alles in één keer
          </button>
        </div>

        {pendoCatalogLoadedAt && (
          <p className="panel__status">
            Catalogus geladen:{' '}
            {new Date(pendoCatalogLoadedAt).toLocaleString('nl-NL')} —{' '}
            {pendoCatalog.length} rapport(en)
          </p>
        )}
        {pendoCatalogNotice && (
          <p className="panel__status">{pendoCatalogNotice}</p>
        )}

        {!!activeReportId && (
          <p className="panel__status">
            {lastPendoSyncAt
              ? `Laatste rapportkoppeling: ${new Date(lastPendoSyncAt).toLocaleString('nl-NL')}`
              : 'Nog geen rapportdata vanuit Pendo op dit dashboard gezet.'}
          </p>
        )}

        {pendoCatalog.length > 0 && (
          <div className="pendo-catalog">
            <label className="field-label" htmlFor="pendo-catalog-search">
              Zoek en filter
            </label>
            <div className="pendo-catalog__controls">
              <input
                id="pendo-catalog-search"
                type="search"
                className="text-input text-input--flex"
                placeholder="Zoek op naam of id…"
                value={pendoCatalogSearch}
                onChange={(e) => setPendoCatalogSearch(e.target.value)}
                autoComplete="off"
              />
              <div className="pendo-kind-filters" role="group" aria-label="Rapporttype">
                {[
                  { id: 'all', label: 'Alles' },
                  { id: 'funnel', label: PENDO_KIND_LABEL.funnel },
                  { id: 'path', label: PENDO_KIND_LABEL.path },
                  { id: 'other', label: PENDO_KIND_LABEL.other },
                ].map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn btn--small${pendoCatalogKind === id ? ' btn--primary' : ' btn--secondary'}`}
                    onClick={() => setPendoCatalogKind(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="pendo-suitable-toggle">
                <input
                  type="checkbox"
                  checked={showOnlySuitable}
                  onChange={(e) => setShowOnlySuitable(e.target.checked)}
                />
                Alleen waarschijnlijk bruikbare rapporten
              </label>
            </div>
            <p className="panel__hint panel__hint--tight">
              {filteredPendoCatalog.length} van {pendoCatalog.length} zichtbaar.
              {' '}
              {analyzedPendoCatalog.filter((e) => e.suitable).length} lijken direct
              bruikbaar voor stap-analyse.
            </p>
            <ul className="pendo-catalog__list">
              {filteredPendoCatalog.map((entry) => (
                <li key={entry.id}>
                  <label className="pendo-catalog__row">
                    <input
                      type="radio"
                      name="pendo-catalog-pick"
                      value={entry.id}
                      checked={selectedCatalogId === entry.id}
                      onChange={() => handleSelectedCatalogIdChange(entry.id)}
                    />
                    <span className="pendo-catalog__row-main">
                      <span className="pendo-catalog__name">{entry.name}</span>
                      <span className="pendo-catalog__meta">
                        <span className="pendo-catalog__badge">
                          {PENDO_KIND_LABEL[entry.kind] || entry.kind}
                        </span>
                        <span
                          className={`pendo-catalog__fit ${
                            entry.suitable ? 'pendo-catalog__fit--yes' : 'pendo-catalog__fit--no'
                          }`}
                        >
                          {entry.suitable
                            ? `${entry.stepCount} stappen herkend`
                            : 'geen stap-volumes gevonden'}
                        </span>
                        <code className="pendo-catalog__id">{entry.id}</code>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="upload-row pendo-catalog__apply">
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleApplySelectedReportToDashboard}
                disabled={!selectedCatalogId || !activeReportId}
              >
                3. Rapportdata op dashboard zetten
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleWaitForPendoRefresh}
                disabled={
                  !selectedCatalogId ||
                  !activeReportId ||
                  pendoWaitLoading ||
                  pendoCatalogLoading
                }
                title="Probeert periodiek opnieuw tot Pendo stap-volumes beschikbaar zijn."
              >
                {pendoWaitLoading
                  ? 'Wachten op Pendo refresh…'
                  : 'Wacht op Pendo refresh'}
              </button>
            </div>
            {pendoWaitStatus && (
              <p className="panel__status panel__hint--tight">{pendoWaitStatus}</p>
            )}
          </div>
        )}

        {(pendoCatalogError || featureError || pendoLinkError) && (
          <div className="inline-errors">
            {pendoCatalogError && <p className="error">{pendoCatalogError}</p>}
            {featureError && <p className="error">{featureError}</p>}
            {pendoLinkError && <p className="error">{pendoLinkError}</p>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Dashboard kiezen</h2>
        <p className="panel__hint">
          Koppel eerst Pendo-data. Op basis van je geselecteerde Pendo-rapport
          wordt het titelveld automatisch ingevuld.
        </p>
        {!selectedCatalogEntry && (
          <p className="panel__status">
            Kies eerst een Pendo-rapport bovenaan om verder te gaan.
          </p>
        )}

        <div className="report-picker">
          <label className="field-label" htmlFor="report-select">
            Actief dashboard
          </label>
          <select
            id="report-select"
            className="select-input"
            value={selectedKey}
            onChange={handleSelectChange}
            disabled={!selectedCatalogEntry}
          >
            <option value="">— Kies een dashboard —</option>
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
            <option value={NEW_VALUE}>+ Nieuw dashboard…</option>
          </select>
        </div>

        {selectedKey === NEW_VALUE && (
          <div className="report-new-block">
            <label className="field-label" htmlFor="new-dash-title">
              Titel nieuw dashboard
            </label>
            <div className="report-new-row">
              <input
                id="new-dash-title"
                className="text-input text-input--flex"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Bijv. Onboarding zorgtraject Q1"
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleCreateDashboard}
                disabled={!selectedCatalogEntry}
              >
                Aanmaken
              </button>
            </div>
            <label className="field-label" htmlFor="new-flow-group">
              Sidebar-groep
            </label>
            <select
              id="new-flow-group"
              className="select-input"
              value={newFlowGroup}
              onChange={(e) => setNewFlowGroup(e.target.value)}
            >
              {REPORT_FLOW_GROUPS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.sidebarLabel}
                </option>
              ))}
            </select>
            <p className="panel__hint panel__hint--tight">
              Bepaalt de kop in het openbare dashboard (zoals professionele vs.
              cliëntflows in het ontwerp).
            </p>
          </div>
        )}

        {activeReportId && (
          <div className="report-title-edit">
            <label className="field-label" htmlFor="edit-dash-title">
              Titel (bewerken)
            </label>
            <div className="report-new-row">
              <input
                id="edit-dash-title"
                className="text-input text-input--flex"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleSaveTitle}
                disabled={!selectedCatalogEntry}
              >
                Titel opslaan
              </button>
            </div>
            <label className="field-label" htmlFor="edit-flow-group">
              Sidebar-groep
            </label>
            <select
              id="edit-flow-group"
              className="select-input"
              value={editFlowGroup}
              onChange={handleFlowGroupChange}
            >
              {REPORT_FLOW_GROUPS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.sidebarLabel}
                </option>
              ))}
            </select>
            <p className="panel__hint panel__hint--tight">
              Wijzigingen worden direct opgeslagen (zichtbaar in het openbare
              dashboard).
            </p>
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Afbeeldingen</h2>
        <p className="panel__hint">
          Voeg screenshots of andere beelden toe ter aanvulling bij de analyse op
          het openbare dashboard. Opgeslagen in de browser (IndexedDB), max.{' '}
          {MAX_IMAGES_PER_REPORT} bestanden, elk max.{' '}
          {MAX_BYTES_PER_IMAGE / 1024 / 1024} MB.
        </p>
        {!activeReportId && (
          <p className="panel__status">Kies eerst een dashboard om te uploaden.</p>
        )}
        {activeReportId && (
          <>
            <div className="upload-row">
              <label className="file-button file-button--secondary">
                Afbeelding(en) kiezen
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    handleImageFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {imageError && <p className="error">{imageError}</p>}
            {imageThumbs.length > 0 && (
              <ul className="report-image-upload-list">
                {imageThumbs.map((img) => (
                  <li key={img.id} className="report-image-upload-item">
                    <figure className="report-image-upload-figure">
                      <img src={img.url} alt="" className="report-image-upload-thumb" />
                      <figcaption className="report-image-upload-caption">
                        {img.fileName}
                      </figcaption>
                    </figure>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      onClick={() => handleDeleteImage(img.id)}
                    >
                      Verwijderen
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <div className="actions-bar">
        <Link to={dashboardHref} className="btn btn--primary btn--large">
          Bekijk dashboard
        </Link>
      </div>

      <p className="page__footer-note">
        <Link to="/" className="text-link">
          Naar openbaar dashboard
        </Link>
        {' · '}
        <Link to="/changelog" className="text-link">
          Changelog
        </Link>
      </p>
    </div>
  );
}
