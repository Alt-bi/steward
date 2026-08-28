import type { CacheEntry } from "../core/messaging";

/**
 * Shared price cache. Lives in the service worker so every tab hits the same
 * entries, and in IndexedDB so it survives worker eviction — the old in-memory
 * map died with the content script on every page load.
 */

const DB_NAME = "srp";
const DB_VERSION = 1;
const STORE = "prices";
const DEFAULT_TTL = 120_000;

interface Row {
  key: string;
  cents: number;
  expires: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("expires", "expires");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb_open_failed"));
  });
  dbPromise = dbPromise.catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb_request_failed"));
  });
}

export async function get(keys: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const key of keys) out[key] = null;
  if (!keys.length) return out;
  try {
    const db = await open();
    const store = tx(db, "readonly");
    const now = Date.now();
    await Promise.all(
      keys.map(async (key) => {
        const row = (await wrap(store.get(key))) as Row | undefined;
        if (row && row.expires > now) out[key] = row.cents;
      })
    );
  } catch {
    /* a broken cache must never block a scan */
  }
  return out;
}

export async function set(entries: CacheEntry[]): Promise<void> {
  if (!entries.length) return;
  try {
    const db = await open();
    const store = tx(db, "readwrite");
    const now = Date.now();
    for (const e of entries) {
      const row: Row = { key: e.key, cents: e.cents, expires: now + (e.ttlMs ?? DEFAULT_TTL) };
      store.put(row);
    }
  } catch {
    /* ignore */
  }
}

export async function clear(): Promise<void> {
  try {
    const db = await open();
    tx(db, "readwrite").clear();
  } catch {
    /* ignore */
  }
}

/** Drops expired rows so the store does not grow without bound. */
export async function sweep(): Promise<void> {
  try {
    const db = await open();
    const store = tx(db, "readwrite");
    const range = IDBKeyRange.upperBound(Date.now());
    const cursorReq = store.index("expires").openCursor(range);
    await new Promise<void>((resolve) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}
