// db.js — capa de persistencia. Toda la app pasa por aquí para leer/escribir.
// No contiene lógica de negocio ni de IA: sólo CRUD sobre IndexedDB.

const DB_NAME = 'pts-studio';
const DB_VERSION = 1;

const STORES = {
  chapters: 'id',
  characters: 'id',
  documents: 'id',
  docChunks: 'id',
  memoryEntries: 'id',
  lockedFacts: 'id',
  canonNotes: 'id',
  settings: 'id',
  generationState: 'id',
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'docChunks') store.createIndex('by_document', 'documentId', { unique: false });
          if (name === 'memoryEntries') store.createIndex('by_chapter', 'chapterId', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

async function getAll(storeName) {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getByIndex(storeName, indexName, value) {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(storeName, id) {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function put(storeName, obj) {
  if (!obj.id) obj.id = uid();
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(obj);
    req.onsuccess = () => resolve(obj);
    req.onerror = () => reject(req.error);
  });
}

async function del(storeName, id) {
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function clearStore(storeName) {
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// ---- Export / import completo (backup) ----
async function exportAll() {
  const dump = {};
  for (const name of Object.keys(STORES)) {
    dump[name] = await getAll(name);
  }
  dump.__meta = { app: 'pts-studio', exportedAt: new Date().toISOString(), version: DB_VERSION };
  return dump;
}

async function importAll(dump, { merge = false } = {}) {
  for (const name of Object.keys(STORES)) {
    if (!Array.isArray(dump[name])) continue;
    if (!merge) await clearStore(name);
    const store = await tx(name, 'readwrite');
    for (const obj of dump[name]) {
      store.put(obj);
    }
  }
  return true;
}

export const db = { openDb, getAll, getByIndex, get, put, del, clearStore, uid, exportAll, importAll };
