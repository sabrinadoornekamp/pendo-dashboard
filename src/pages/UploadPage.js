import { useCallback, useEffect, useRef, useState } from 'react';
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
  fetchPendoFeatures,
  fetchPendoFunnels,
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

  const [funnelError, setFunnelError] = useState(null);
  const [featureError, setFeatureError] = useState(null);
  const [pendoError, setPendoError] = useState(null);
  const [pendoLoading, setPendoLoading] = useState(false);
  const [pendoFunnels, setPendoFunnels] = useState([]);
  const [selectedPendoFunnelId, setSelectedPendoFunnelId] = useState('');
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

  const handleRefreshPendoData = useCallback(async () => {
    setPendoError(null);
    setFunnelError(null);
    setFeatureError(null);
    setStorageError(null);
    if (!activeReportId) {
      setPendoError('Selecteer of maak eerst een dashboard met een titel.');
      return;
    }
    if (!pendoApiKey) {
      setPendoError(
        'Pendo API key ontbreekt. Zet REACT_APP_PENDO_API_KEY in .env en herstart npm start.'
      );
      return;
    }

    setPendoLoading(true);
    const ac = new AbortController();
    try {
      const [funnels, features] = await Promise.all([
        fetchPendoFunnels(pendoApiKey, ac.signal),
        fetchPendoFeatures(pendoApiKey, ac.signal),
      ]);
      if (!funnels.length) {
        throw new Error('Geen funnels ontvangen van Pendo.');
      }
      if (!features.length) {
        throw new Error('Geen feature-adoptiedata ontvangen van Pendo.');
      }

      setPendoFunnels(funnels);
      const preferredId =
        selectedPendoFunnelId && funnels.some((f) => f.id === selectedPendoFunnelId)
          ? selectedPendoFunnelId
          : funnels[0].id;
      setSelectedPendoFunnelId(preferredId);
      const selectedRaw = funnels.find((f) => f.id === preferredId)?.raw;
      const normalizedFunnel = normalizePendoFunnelForReport(selectedRaw);
      if (!normalizedFunnel) {
        throw new Error(
          'Gekozen funnel bevat geen bruikbare stapdata (stap + gebruikers).'
        );
      }

      const saved = persistReportPatch(activeReportId, {
        funnel: normalizedFunnel,
        features,
      });
      if (!saved.ok) {
        throw new Error(saved.message || 'Opslaan van Pendo-data mislukte.');
      }
      const syncedAt = new Date().toISOString();
      try {
        const raw = localStorage.getItem(LS_PENDO_SYNC);
        const map = raw ? JSON.parse(raw) : {};
        map[activeReportId] = {
          syncedAt,
          funnelId: preferredId,
          funnelName: funnels.find((f) => f.id === preferredId)?.name || null,
        };
        localStorage.setItem(LS_PENDO_SYNC, JSON.stringify(map));
      } catch {
        /* ignore metadata storage errors */
      }
      setLastPendoSyncAt(syncedAt);
      bumpReports();
      flashSaved('Pendo-data ververst en opgeslagen.');
    } catch (e) {
      setPendoError(e?.message || 'Pendo-data ophalen mislukte.');
    } finally {
      setPendoLoading(false);
      ac.abort();
    }
  }, [
    activeReportId,
    bumpReports,
    flashSaved,
    pendoApiKey,
    selectedPendoFunnelId,
  ]);

  const handleSelectedFunnelApply = useCallback(() => {
    setPendoError(null);
    setStorageError(null);
    if (!activeReportId) {
      setPendoError('Selecteer of maak eerst een dashboard met een titel.');
      return;
    }
    const selectedRaw = pendoFunnels.find((f) => f.id === selectedPendoFunnelId)?.raw;
    const normalizedFunnel = normalizePendoFunnelForReport(selectedRaw);
    if (!normalizedFunnel) {
      setPendoError('Geselecteerde funnel bevat geen bruikbare stapdata.');
      return;
    }
    const res = persistReportPatch(activeReportId, { funnel: normalizedFunnel });
    if (!res.ok) {
      setPendoError(res.message || 'Opslaan van funnel mislukt.');
      return;
    }
    const syncedAt = new Date().toISOString();
    try {
      const raw = localStorage.getItem(LS_PENDO_SYNC);
      const map = raw ? JSON.parse(raw) : {};
      map[activeReportId] = {
        syncedAt,
        funnelId: selectedPendoFunnelId || null,
        funnelName:
          pendoFunnels.find((f) => f.id === selectedPendoFunnelId)?.name || null,
      };
      localStorage.setItem(LS_PENDO_SYNC, JSON.stringify(map));
    } catch {
      /* ignore */
    }
    setLastPendoSyncAt(syncedAt);
    bumpReports();
    flashSaved('Geselecteerde funnel toegepast op dit dashboard.');
  }, [activeReportId, bumpReports, flashSaved, pendoFunnels, selectedPendoFunnelId]);

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
        <h2 className="panel__title">Dashboard kiezen</h2>
        <p className="panel__hint">
          Stakeholders kiezen flows in de zijbalk, gegroepeerd onder
          professionele flows, cliëntflows of overig. Elke titel hoort bij een
          aparte funnel-export.
        </p>

        <div className="report-picker">
          <label className="field-label" htmlFor="report-select">
            Actief dashboard
          </label>
          <select
            id="report-select"
            className="select-input"
            value={selectedKey}
            onChange={handleSelectChange}
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
        <h2 className="panel__title">Pendo API</h2>
        <p className="panel__hint">
          Haal live funnel- en featuredata op vanuit Pendo en sla direct op voor
          het geselecteerde dashboard.
        </p>
        <div className="upload-row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleRefreshPendoData}
            disabled={pendoLoading || !activeReportId}
          >
            {pendoLoading ? 'Verversen…' : 'Ververs data'}
          </button>
        </div>
        {!!activeReportId && (
          <p className="panel__status">
            {lastPendoSyncAt
              ? `Laatste synchronisatie: ${new Date(lastPendoSyncAt).toLocaleString('nl-NL')}`
              : 'Nog niet gesynchroniseerd met Pendo.'}
          </p>
        )}
        {pendoFunnels.length > 0 && (
          <div className="report-picker">
            <label className="field-label" htmlFor="pendo-funnel-select">
              Te tonen funnel
            </label>
            <div className="report-new-row">
              <select
                id="pendo-funnel-select"
                className="select-input text-input--flex"
                value={selectedPendoFunnelId}
                onChange={(e) => setSelectedPendoFunnelId(e.target.value)}
              >
                {pendoFunnels.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleSelectedFunnelApply}
                disabled={!selectedPendoFunnelId || !activeReportId}
              >
                Toepassen
              </button>
            </div>
          </div>
        )}
        {(funnelError || featureError || pendoError) && (
          <div className="inline-errors">
            {funnelError && <p className="error">{funnelError}</p>}
            {featureError && <p className="error">{featureError}</p>}
            {pendoError && <p className="error">{pendoError}</p>}
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
