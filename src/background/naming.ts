import type { GroupEntry } from "../core/messaging";

/**
 * Learned internal names for the listing book, kept in the service worker so
 * every tab reads the same facts, and in IndexedDB so they survive worker
 * eviction. Unlike prices these carry no TTL: a group id is a stable fact about
 * how Steam names an item, not a quote — and when one stops working, the scan
 * notices on its own and drops it.
 */

const DB_NAME = "srp-naming";
const DB_VERSION = 1;
const STORE = "naming";

interface Row {
  hash: string;
  appid: number;
  groupId: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "hash" });
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

export async function get(keys: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = null;
  if (!keys.length) return out;
  try {
    const db = await open();
    const store = tx(db, "readonly");
    const rows = await wrap<any[]>(store.getAll());
    const byHash = new Map<string, Row>();
    for (const row of rows) if (row?.hash) byHash.set(row.hash, row);
    for (const key of keys) {
      const row = byHash.get(key);
      out[key] = typeof row?.groupId === "string" && row.groupId ? row.groupId : null;
    }
    return out;
  } catch {
    return out;
  }
}

/** Upsert only well-formed facts; an empty name would poison the store. */
export async function set(entries: GroupEntry[]): Promise<void> {
  const clean = entries.filter(
    (e) => e && e.hash && e.groupId && e.groupId !== e.hash && Number.isFinite(e.appid)
  );
  if (!clean.length) return;
  try {
    const db = await open();
    const store = tx(db, "readwrite");
    for (const e of clean) {
      store.put({ hash: e.hash, appid: e.appid, groupId: e.groupId });
    }
  } catch {
    /** The scan works without the store; a failed write just costs a request. */
  }
}

export async function drop(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const db = await open();
    const store = tx(db, "readwrite");
    for (const key of keys) store.delete(key);
  } catch {
    /** Nothing to undo: the next scan learns the name again. */
  }
}