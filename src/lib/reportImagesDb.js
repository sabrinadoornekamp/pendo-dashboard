/** Afbeeldingen per dashboard in IndexedDB (localStorage is te klein voor blobs). */

export const REPORT_IMAGES_CHANGED = 'tl-report-images-changed';

const DB_NAME = 'tl-userflow-report-images';
const DB_VERSION = 1;
const STORE = 'images';

export const MAX_IMAGES_PER_REPORT = 24;
export const MAX_BYTES_PER_IMAGE = 8 * 1024 * 1024; // 8 MB

const bc =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('tl-report-images')
    : null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('reportId', 'reportId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function notifyReportImagesChanged(reportId) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(REPORT_IMAGES_CHANGED, { detail: { reportId } })
  );
  try {
    bc?.postMessage({ type: 'changed', reportId });
  } catch {
    /* ignore */
  }
}

/** Cross-tab: roept callback aan met reportId wanneer ergens afbeeldingen wijzigen. */
export function subscribeReportImagesChanged(callback) {
  if (typeof window === 'undefined') return () => {};

  const onWin = (e) => {
    const rid = e.detail?.reportId;
    if (rid) callback(rid);
  };
  window.addEventListener(REPORT_IMAGES_CHANGED, onWin);

  const onBc = (e) => {
    if (e.data?.type === 'changed' && e.data.reportId) {
      callback(e.data.reportId);
    }
  };
  bc?.addEventListener('message', onBc);

  return () => {
    window.removeEventListener(REPORT_IMAGES_CHANGED, onWin);
    bc?.removeEventListener('message', onBc);
  };
}

/**
 * @param {string} reportId
 * @returns {Promise<Array<{ id: number, reportId: string, blob: Blob, fileName: string, mimeType: string, createdAt: number }>>}
 */
export async function listImagesForReport(reportId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const ix = tx.objectStore(STORE).index('reportId');
    const r = ix.getAll(reportId);
    r.onsuccess = () => {
      const rows = r.result || [];
      rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      resolve(rows);
    };
    r.onerror = () => reject(r.error);
  });
}

/**
 * @param {string} reportId
 * @param {File[]} files
 */
export async function addImagesToReport(reportId, files) {
  if (!files.length) return;

  const existing = await listImagesForReport(reportId);
  if (existing.length + files.length > MAX_IMAGES_PER_REPORT) {
    throw new Error(
      `Maximaal ${MAX_IMAGES_PER_REPORT} afbeeldingen per dashboard. Verwijder eerst enkele bestanden.`
    );
  }

  for (const f of files) {
    if (!f.type.startsWith('image/')) {
      throw new Error(`“${f.name}” is geen afbeelding (alleen image/*).`);
    }
    if (f.size > MAX_BYTES_PER_IMAGE) {
      throw new Error(
        `“${f.name}” is te groot (max. ${MAX_BYTES_PER_IMAGE / 1024 / 1024} MB per bestand).`
      );
    }
  }

  const db = await openDb();
  let baseTime = Date.now();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const file of files) {
      store.add({
        reportId,
        blob: file,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        createdAt: baseTime++,
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  notifyReportImagesChanged(reportId);
}

/**
 * @param {number} imageId
 * @returns {Promise<boolean>} true als verwijderd
 */
export async function deleteReportImage(imageId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let reportIdToNotify = null;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const g = store.get(imageId);
    g.onsuccess = () => {
      const row = g.result;
      if (row) {
        reportIdToNotify = row.reportId;
        store.delete(imageId);
      }
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => {
      if (reportIdToNotify) notifyReportImagesChanged(reportIdToNotify);
      resolve(!!reportIdToNotify);
    };
    tx.onerror = () => reject(tx.error);
  });
}
