// Lessons are saved on this device only (IndexedDB). Nothing is uploaded.
const DB_NAME = 'read-along';
const STORE = 'lessons';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Save was cancelled'));
  }));
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listLessons() {
  const all = await tx('readonly', (s) => req2p(s.getAll()));
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export function getLesson(id) { return tx('readonly', (s) => req2p(s.get(id))); }
export function saveLesson(lesson) {
  lesson.updatedAt = Date.now();
  return tx('readwrite', (s) => req2p(s.put(lesson)));
}
export function deleteLesson(id) { return tx('readwrite', (s) => req2p(s.delete(id))); }

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Ask the browser not to clear saved lessons when the phone runs low on space.
export async function askPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
}

// ---- lesson files, for moving a lesson to another device -----------------
// Layout: "READALONG1\n" + 4-byte JSON length + JSON + recording bytes.
const MAGIC = 'READALONG1\n';

export async function lessonToFile(lesson) {
  const { audio, ...rest } = lesson;
  const meta = new TextEncoder().encode(JSON.stringify({ ...rest, audioType: audio.type }));
  const head = new TextEncoder().encode(MAGIC);
  const len = new DataView(new ArrayBuffer(4));
  len.setUint32(0, meta.length, true);
  return new Blob([head, len.buffer, meta, audio], { type: 'application/octet-stream' });
}

export async function lessonFromFile(file) {
  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, MAGIC.length));
  if (head !== MAGIC) throw new Error('This file is not a Read-Along lesson file.');
  const n = new DataView(buf, MAGIC.length, 4).getUint32(0, true);
  const metaStart = MAGIC.length + 4;
  const meta = JSON.parse(new TextDecoder().decode(buf.slice(metaStart, metaStart + n)));
  const audio = new Blob([buf.slice(metaStart + n)], { type: meta.audioType || 'audio/webm' });
  delete meta.audioType;
  return { ...meta, audio };
}
