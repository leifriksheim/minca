/**
 * @module indexeddb-adapter
 * The browser's StorageAdapter: a key-value store and a store of versions by id.
 */

import type { StorageAdapter, BatchOp, Version } from '../types.js';
import { isStoredVersion } from '../utils/guards.js';
import { requestResult, transactionDone } from '../identity/idb.js';

/**
 * Bumped whenever the object stores change. Opening a database made at an
 * earlier one wipes it: it is a local copy, rebuilt by syncing with peers.
 */
const DB_VERSION = 4;

/** Creates an IndexedDB backed storage adapter */
export async function createIndexedDBAdapter(dbName = 'minca-storage'): Promise<StorageAdapter> {
  const db = await openDatabase(dbName);

  const reading = (name: string) => db.transaction([name], 'readonly').objectStore(name);

  /** Runs `work` in one read-write transaction, settling once it commits */
  async function writing(names: string[], work: (tx: IDBTransaction) => void): Promise<void> {
    const tx = db.transaction(names, 'readwrite');
    const complete = transactionDone(tx);
    work(tx);
    await complete;
  }

  return Object.freeze({
    async get(key: string): Promise<Uint8Array | null> {
      const result = await requestResult<unknown>(reading('kv').get(key));
      return result instanceof ArrayBuffer ? new Uint8Array(result) : null;
    },

    put: (key: string, value: Uint8Array) =>
      writing(['kv'], (tx) => tx.objectStore('kv').put(value.buffer, key)),

    delete: (key: string) => writing(['kv'], (tx) => tx.objectStore('kv').delete(key)),

    async list(prefix = ''): Promise<string[]> {
      const store = reading('kv');
      const keys = await requestResult(prefix ? store.getAllKeys(under(prefix)) : store.getAllKeys());
      return keys.filter((key) => typeof key === 'string');
    },

    async entries(prefix: string): Promise<ReadonlyArray<readonly [string, Uint8Array]>> {
      const store = reading('kv');
      // Both in key order, from one transaction: they line up.
      const [keys, values] = await Promise.all([
        requestResult(store.getAllKeys(under(prefix))),
        requestResult(store.getAll(under(prefix))),
      ]);
      return keys.flatMap((key, i) => {
        const value: unknown = values[i];
        return typeof key === 'string' && value instanceof ArrayBuffer
          ? [[key, new Uint8Array(value)] as const]
          : [];
      });
    },

    commit: (write: {
      readonly store: ReadonlyArray<Version>;
      readonly ops: ReadonlyArray<BatchOp>;
      readonly remove: ReadonlyArray<string>;
    }) =>
      writing(['kv', 'versions'], (tx) => {
        const versions = tx.objectStore('versions');
        for (const version of write.store) versions.put(version);
        applyOps(tx.objectStore('kv'), write.ops);
        for (const id of write.remove) versions.delete(id);
      }),

    async getVersions(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Version | null>> {
      if (ids.length === 0) return [];
      const store = reading('versions');
      return Promise.all(ids.map((id) => readVersion(store.get(id))));
    },

    putVersion: (version: Version) => writing(['versions'], (tx) => tx.objectStore('versions').put(version)),

    getVersion: (id: string) => readVersion(reading('versions').get(id)),

    deleteVersion: (id: string) => writing(['versions'], (tx) => tx.objectStore('versions').delete(id)),

    batch: (ops: ReadonlyArray<BatchOp>) => writing(['kv'], (tx) => applyOps(tx.objectStore('kv'), ops)),

    async close(): Promise<void> {
      db.close();
    },
  });
}

/** Opens the database, wiping one made at an earlier version */
function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      // Which version is current, what sync compares, space records
      db.createObjectStore('kv');
      db.createObjectStore('versions', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${dbName}`));
  });
}

/** Every key starting with `prefix` */
const under = (prefix: string) => IDBKeyRange.bound(prefix, prefix + '￿', false, false);

function applyOps(kv: IDBObjectStore, ops: ReadonlyArray<BatchOp>): void {
  for (const op of ops) {
    if (op.type === 'put') kv.put(op.value.buffer, op.key);
    else kv.delete(op.key);
  }
}

/** A stored version, or null for a miss */
async function readVersion(request: IDBRequest<unknown>): Promise<Version | null> {
  const value = await requestResult(request);
  return isStoredVersion(value) ? value : null;
}
