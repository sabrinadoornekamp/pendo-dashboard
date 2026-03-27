import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Papa from 'papaparse';
import {
  REPORT_FLOW_GROUPS,
  createReport,
  listReportsSorted,
  loadReport,
  loadReportsStore,
  persistReportPatch,
  rawFunnelFromPapaResults,
  normalizeFunnelTableForReport,
  updateReportTitle,
} from '../lib/flowData';
import {
  fetchPendoReportCatalog,
} from '../lib/pendoApi';
import {
  addImagesToReport,
  deleteReportImage,
  listImagesForReport,
} from '../lib/reportImagesDb';

const UPLOAD_PASSWORD = 'therapieland2025';
const SESSION_KEY = 'tl_analyst_session';
const NEW_VALUE = '__new__';

const PENDO_KIND_LABEL = {
  funnel: 'Funnel',
  path: 'Pad / journey',
  other: 'Overig',
};

const PENDO_KEY_HINT =
  'Pendo API key ontbreekt. Zet REACT_APP_PENDO_API_KEY in .env en herstart npm start.';

function readSessionUnlocked() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
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
  const [pendoCatalogLoading, setPendoCatalogLoading] = useState(false);
  const [pendoCatalog, setPendoCatalog] = useState([]);
  const [pendoCatalogSearch, setPendoCatalogSearch] = useState('');
  const [pendoCatalogKind, setPendoCatalogKind] = useState('all');
  const [selectedCatalogId, setSelectedCatalogId] = useState('');
  const [manualCsvError, setManualCsvError] = useState(null);
  const [selectedReportCsvFile, setSelectedReportCsvFile] = useState(null);
  const [selectedImageFiles, setSelectedImageFiles] = useState([]);
  const [selectedLiveFlowKeys, setSelectedLiveFlowKeys] = useState([]);
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
    () => pendoCatalog,
    [pendoCatalog]
  );

  const filteredPendoCatalog = useMemo(() => {
    let rows = analyzedPendoCatalog;
    if (pendoCatalogKind !== 'all') {
      rows = rows.filter((e) => e.kind === pendoCatalogKind);
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
  }, [analyzedPendoCatalog, pendoCatalogKind, pendoCatalogSearch]);

  const selectedCatalogEntry = useMemo(
    () => analyzedPendoCatalog.find((e) => e.id === selectedCatalogId) || null,
    [analyzedPendoCatalog, selectedCatalogId]
  );

  const allLiveFlows = useMemo(() => {
    const items = [];
    reports.forEach((report) => {
      const table = normalizeFunnelTableForReport(report);
      const rows = table?.rows || [];
      if (!rows.length) return;
      const counts = new Map();
      rows.forEach((row) => {
        const name = String(row?.flow || row?.sourceFile || 'Onbekende flow').trim();
        counts.set(name, (counts.get(name) || 0) + 1);
      });
      counts.forEach((count, flowName) => {
        items.push({
          key: `${report.id}::${flowName}`,
          reportId: report.id,
          reportTitle: report.title,
          flowName,
          rowCount: count,
        });
      });
    });
    return items.sort((a, b) => {
      if (a.reportTitle !== b.reportTitle) {
        return a.reportTitle.localeCompare(b.reportTitle, 'nl-NL');
      }
      return a.flowName.localeCompare(b.flowName, 'nl-NL');
    });
  }, [reports]);

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

  const handleLoadPendoCatalog = useCallback(async () => {
    setPendoCatalogError(null);
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
        setPendoCatalogError(scopeWarning);
      }
      const preferred = entries[0];
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

  const handleSelectedCatalogIdChange = useCallback(
    (id) => {
      setSelectedCatalogId(id);
      const entry = analyzedPendoCatalog.find((e) => e.id === id);
      syncTitleWithPendoSelection(entry?.name);
    },
    [analyzedPendoCatalog, syncTitleWithPendoSelection]
  );


  const handleManualReportCsvUpload = useCallback(
    async (file) => {
      setManualCsvError(null);
      if (!activeReportId) {
        setManualCsvError('Selecteer eerst een dashboard.');
        return;
      }
      if (!file) return;
      try {
        const csvText = await file.text();
        if (!csvText || !csvText.trim()) {
          throw new Error('Het CSV-bestand is leeg.');
        }
        const parsed = Papa.parse(csvText, {
          header: true,
          skipEmptyLines: 'greedy',
        });
        const incoming = rawFunnelFromPapaResults(parsed);
        if (!incoming.rows.length) {
          throw new Error('Geen geldige rijen gevonden in dit CSV-bestand.');
        }

        const existingReport = loadReport(activeReportId);
        const existingTable = normalizeFunnelTableForReport(existingReport) || {
          columns: [],
          rows: [],
        };
        const flowLabel =
          selectedCatalogEntry?.name ||
          file.name.replace(/\.csv$/i, '').trim() ||
          'Flow';
        const taggedRows = incoming.rows.map((row) => ({
          ...row,
          flow: flowLabel,
          sourceFile: file.name,
        }));
        const mergedRows = [...(existingTable.rows || []), ...taggedRows];
        const mergedFields = [
          ...new Set([
            ...(existingTable.columns || []),
            ...(incoming.fields || []),
            'flow',
            'sourceFile',
          ]),
        ];

        const saved = persistReportPatch(activeReportId, {
          funnel: {
            fields: mergedFields,
            rows: mergedRows,
          },
        });
        if (!saved.ok) throw new Error(saved.message || 'Opslaan mislukt.');
        bumpReports();
        setSelectedReportCsvFile(null);
        flashSaved(
          `CSV toegevoegd (${taggedRows.length} rijen). Meerdere flows staan nu onder dit dashboard.`
        );
      } catch (e) {
        setManualCsvError(e?.message || 'CSV uploaden mislukt.');
      }
    },
    [activeReportId, bumpReports, flashSaved, selectedCatalogEntry]
  );

  const handleDeleteAllFlows = useCallback(() => {
    if (!activeReportId) return;
    const saved = persistReportPatch(activeReportId, { funnel: null });
    if (!saved.ok) {
      setManualCsvError(saved.message || 'Flows verwijderen mislukt.');
      return;
    }
    setManualCsvError(null);
    bumpReports();
    flashSaved('Alle flows verwijderd uit dit dashboard.');
  }, [activeReportId, bumpReports, flashSaved]);

  const toggleLiveFlowSelection = useCallback((flowKey) => {
    setSelectedLiveFlowKeys((prev) =>
      prev.includes(flowKey) ? prev.filter((k) => k !== flowKey) : [...prev, flowKey]
    );
  }, []);

  const handleDeleteSelectedLiveFlows = useCallback(() => {
    if (!selectedLiveFlowKeys.length) return;
    const grouped = new Map();
    selectedLiveFlowKeys.forEach((key) => {
      const [reportId, ...nameParts] = String(key).split('::');
      const flowName = nameParts.join('::');
      if (!reportId || !flowName) return;
      if (!grouped.has(reportId)) grouped.set(reportId, new Set());
      grouped.get(reportId).add(flowName);
    });

    for (const [reportId, flowNames] of grouped.entries()) {
      const report = loadReport(reportId);
      const table = normalizeFunnelTableForReport(report);
      const rows = table?.rows || [];
      if (!rows.length) continue;
      const nextRows = rows.filter((row) => {
        const rowFlow = String(row?.flow || row?.sourceFile || 'Onbekende flow').trim();
        return !flowNames.has(rowFlow);
      });
      const nextFunnel =
        nextRows.length > 0
          ? {
              fields: table?.columns || Object.keys(nextRows[0] || {}),
              rows: nextRows,
            }
          : null;
      const saved = persistReportPatch(reportId, { funnel: nextFunnel });
      if (!saved.ok) {
        setManualCsvError(saved.message || 'Geselecteerde flows verwijderen mislukt.');
        return;
      }
    }

    setManualCsvError(null);
    setSelectedLiveFlowKeys([]);
    bumpReports();
    flashSaved('Geselecteerde flows verwijderd.');
  }, [bumpReports, flashSaved, selectedLiveFlowKeys]);

  const handleDeleteSingleLiveFlow = useCallback(
    (flowKey) => {
      setSelectedLiveFlowKeys([flowKey]);
      const [reportId, ...nameParts] = String(flowKey).split('::');
      const flowName = nameParts.join('::');
      if (!reportId || !flowName) return;
      const report = loadReport(reportId);
      const table = normalizeFunnelTableForReport(report);
      const rows = table?.rows || [];
      if (!rows.length) return;
      const nextRows = rows.filter((row) => {
        const rowFlow = String(row?.flow || row?.sourceFile || 'Onbekende flow').trim();
        return rowFlow !== flowName;
      });
      const nextFunnel =
        nextRows.length > 0
          ? {
              fields: table?.columns || Object.keys(nextRows[0] || {}),
              rows: nextRows,
            }
          : null;
      const saved = persistReportPatch(reportId, { funnel: nextFunnel });
      if (!saved.ok) {
        setManualCsvError(saved.message || 'Flow verwijderen mislukt.');
        return;
      }
      setManualCsvError(null);
      setSelectedLiveFlowKeys([]);
      bumpReports();
      flashSaved(`Flow verwijderd: ${flowName}`);
    },
    [bumpReports, flashSaved]
  );


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
    <div className="page page--upload">
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

        <div className="pendo-toolbar">
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleLoadPendoCatalog}
            disabled={pendoCatalogLoading}
          >
            {pendoCatalogLoading ? 'Rapporten laden…' : '1. Rapporten ophalen'}
          </button>
        </div>

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
            </div>
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
                        <code className="pendo-catalog__id">{entry.id}</code>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {pendoCatalogError && (
          <div className="inline-errors">
            {pendoCatalogError && <p className="error">{pendoCatalogError}</p>}
          </div>
        )}
      </section>

      <section className="panel panel--dashboard-pick">
        <h2 className="panel__title">Dashboard kiezen</h2>
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
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Handmatig aanvullen</h2>
        {!activeReportId && (
          <p className="panel__status">Kies eerst een dashboard om te uploaden.</p>
        )}
        {activeReportId && (
          <>
            <div className="upload-row">
              <label className="file-button file-button--secondary">
                Rapportdata CSV kiezen
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) =>
                    setSelectedReportCsvFile(e.target.files?.[0] || null)
                  }
                />
              </label>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => handleManualReportCsvUpload(selectedReportCsvFile)}
                disabled={!selectedReportCsvFile}
              >
                Rapportdata uploaden
              </button>
            </div>
            {selectedReportCsvFile && (
              <p className="panel__status">
                Gekozen bestand: {selectedReportCsvFile.name}
              </p>
            )}
          </>
        )}
        {manualCsvError && <p className="error">{manualCsvError}</p>}
      </section>

      <section className="panel">
        <h2 className="panel__title">Flows beheren</h2>
        {allLiveFlows.length === 0 && (
          <p className="panel__status">Nog geen flows gevonden.</p>
        )}
        {allLiveFlows.length > 0 && (
          <>
            <div className="upload-row" style={{ marginBottom: '12px' }}>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleDeleteAllFlows}
                disabled={!activeReportId}
              >
                Alle flows uit actief dashboard verwijderen
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleDeleteSelectedLiveFlows}
                disabled={!selectedLiveFlowKeys.length}
              >
                Geselecteerde flows verwijderen
              </button>
            </div>
            <ul className="pendo-catalog__list">
              {allLiveFlows.map((flow) => (
                <li key={flow.key}>
                  <div className="pendo-catalog__row">
                    <input
                      type="checkbox"
                      checked={selectedLiveFlowKeys.includes(flow.key)}
                      onChange={() => toggleLiveFlowSelection(flow.key)}
                    />
                    <span className="pendo-catalog__row-main">
                      <span className="pendo-catalog__name">{flow.flowName}</span>
                      <span className="pendo-catalog__meta">
                        <span className="pendo-catalog__id">{flow.reportTitle}</span>
                        <span className="pendo-catalog__id">{flow.rowCount} rijen</span>
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      onClick={() => handleDeleteSingleLiveFlow(flow.key)}
                    >
                      Verwijderen
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Afbeeldingen</h2>
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
                    setSelectedImageFiles(Array.from(e.target.files || []));
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn--primary"
                onClick={async () => {
                  await handleImageFiles(selectedImageFiles);
                  setSelectedImageFiles([]);
                }}
                disabled={!selectedImageFiles.length}
              >
                Afbeeldingen uploaden
              </button>
            </div>
            {selectedImageFiles.length > 0 && (
              <p className="panel__status">
                Gekozen: {selectedImageFiles.map((f) => f.name).join(', ')}
              </p>
            )}
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
