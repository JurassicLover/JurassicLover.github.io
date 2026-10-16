// Almacenamiento local con IndexedDB.
const DB_NAME = 'margen';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('chatId', 'chatId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode = 'readonly') {
  const db = await open();
  return db.transaction(store, mode).objectStore(store);
}

export async function get(store, key) { return wrap((await tx(store)).get(key)); }
export async function all(store) { return wrap((await tx(store)).getAll()); }
export async function put(store, value) { return wrap((await tx(store, 'readwrite')).put(value)); }
export async function del(store, key) { return wrap((await tx(store, 'readwrite')).delete(key)); }
export async function clear(store) { return wrap((await tx(store, 'readwrite')).clear()); }
export async function byIndex(store, index, value) {
  return wrap((await tx(store)).index(index).getAll(value));
}

export async function deleteChat(chatId) {
  const msgs = await byIndex('messages', 'chatId', chatId);
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['messages', 'chats'], 'readwrite');
    msgs.forEach(m => t.objectStore('messages').delete(m.id));
    t.objectStore('chats').delete(chatId);
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}

export async function deleteBook(id) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['books', 'texts', 'files'], 'readwrite');
    ['books', 'texts', 'files'].forEach(s => t.objectStore(s).delete(id));
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
