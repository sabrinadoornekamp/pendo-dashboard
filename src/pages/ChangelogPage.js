import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

function formatCommitDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('nl-NL', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export default function ChangelogPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const base = process.env.PUBLIC_URL || '';
    const url = `${base.replace(/\/$/, '')}/changelog.json`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message || 'Laden mislukt'));
  }, []);

  const commits = Array.isArray(data?.commits) ? data.commits : [];
  const repo = data?.repositoryUrl;

  return (
    <div className="page page--changelog">
      <header className="page__header">
        <h1 className="brand-title">Changelog</h1>
        <p className="page__lede page__lede--muted">
          Overzicht van wijzigingen op basis van git-commits. Wordt automatisch
          bijgewerkt bij <code className="inline-code">npm start</code> en{' '}
          <code className="inline-code">npm run build</code>.
        </p>
      </header>

      {error && (
        <section className="panel panel--soft changelog-panel">
          <p className="changelog-error">
            Changelog kon niet worden geladen ({error}). Voer lokaal{' '}
            <code className="inline-code">npm run changelog</code> uit of start
            de dev-server opnieuw.
          </p>
        </section>
      )}

      {!error && !data && (
        <p className="page__lede--muted">Changelog laden…</p>
      )}

      {data && (
        <section className="panel panel--soft changelog-panel">
          <p className="changelog-meta">
            {data.generatedAt ? (
              <>
                Laatst gegenereerd:{' '}
                <strong>{formatCommitDate(data.generatedAt)}</strong>
              </>
            ) : (
              <>Nog niet gegenereerd — start de app of build opnieuw.</>
            )}
            {repo && (
              <>
                {' · '}
                <a
                  href={repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link"
                >
                  Repository
                </a>
              </>
            )}
          </p>

          {commits.length === 0 ? (
            <p className="page__lede--muted changelog-empty">
              Geen commits gevonden (geen git-historie of lege repository).
            </p>
          ) : (
            <ul className="changelog-list">
              {commits.map((c) => (
                <li key={c.hash} className="changelog-item">
                  <div className="changelog-item__head">
                    <time
                      className="changelog-item__date"
                      dateTime={c.date}
                    >
                      {formatCommitDate(c.date)}
                    </time>
                    {repo && (
                      <a
                        href={`${repo}/commit/${c.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="changelog-item__hash text-link"
                      >
                        {c.shortHash}
                      </a>
                    )}
                    {!repo && (
                      <span className="changelog-item__hash">{c.shortHash}</span>
                    )}
                  </div>
                  <p className="changelog-item__subject">{c.subject}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="page__footer-note">
        <Link to="/" className="text-link">
          Terug naar dashboard
        </Link>
        {' · '}
        <Link to="/upload" className="text-link">
          Upload (analisten)
        </Link>
      </p>
    </div>
  );
}
