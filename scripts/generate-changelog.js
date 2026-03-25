/**
 * Schrijft public/changelog.json op basis van git log (laatste commits).
 * Draait via prebuild / prestart zodat productie en lokaal automatisch up-to-date zijn.
 */
/* eslint-disable no-console */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'changelog.json');
const MAX_COMMITS = 200;

function getOriginUrl() {
  try {
    return execSync('git remote get-url origin', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function githubBaseFromRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?/i);
  if (!m) return null;
  return `https://github.com/${m[1]}`;
}

function parseLog(raw) {
  const RS = '\x1e';
  const US = '\x1f';
  const chunks = raw.split(RS).filter(Boolean);
  const commits = [];
  for (const chunk of chunks) {
    const parts = chunk.split(US);
    if (parts.length < 3) continue;
    const [hash, ts, subject] = parts;
    const t = parseInt(ts, 10);
    if (!hash || Number.isNaN(t) || !subject) continue;
    commits.push({
      hash: hash.trim(),
      shortHash: hash.trim().slice(0, 7),
      date: new Date(t * 1000).toISOString(),
      subject: subject.trim(),
    });
  }
  return commits;
}

function main() {
  const generatedAt = new Date().toISOString();
  const repositoryUrl = githubBaseFromRemote(getOriginUrl());

  let commits = [];
  try {
    const fmt = `%H${'\x1f'}%ct${'\x1f'}%s${'\x1e'}`;
    const r = spawnSync(
      'git',
      ['log', '-n', String(MAX_COMMITS), '--no-merges', `--pretty=format:${fmt}`],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    if (r.error) throw r.error;
    if (r.status !== 0) {
      throw new Error((r.stderr && r.stderr.trim()) || `git exit ${r.status}`);
    }
    commits = parseLog(r.stdout || '');
  } catch (e) {
    console.warn(
      '[changelog] git log niet beschikbaar (geen .git of geen commits):',
      e.message || e
    );
  }

  const payload = {
    generatedAt,
    source: 'git',
    repositoryUrl,
    commits,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `[changelog] ${OUT} — ${commits.length} commit(s)${
      repositoryUrl ? `, repo ${repositoryUrl}` : ''
    }`
  );
}

main();
