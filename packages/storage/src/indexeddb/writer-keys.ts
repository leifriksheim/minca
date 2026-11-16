/**
 * Lasting writer keys in this origin's IndexedDB: a `WriterKeySource`, with a
 * slot for each tab or worker signing at once, locked with Web Locks.
 */
import {
  createP256Provider,
  type ClaimedWriter,
  type CryptoProvider,
  type HeadStore,
  type WriterKeySource,
} from '@minca/core';
import { idbRun, openDb } from './idb.js';

/** How many slots one account keeps in one browser: one per tab or worker signing at once */
const MAX_SLOTS = 32;
const STORE = 'writer';
/** Where a slot keeps what its key is derived from */
const KEY_SEED = 'seed';

/** The lock for a slot, if no one holds it; held until the function returned is called */
function tryLock(locks: LockManager, name: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    void locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(null));
  });
}

/**
 * Lasting keys in this origin's IndexedDB, one database per slot, locked with
 * Web Locks across tabs and workers. A slot keeps the seed its key is derived
 * from, not a `CryptoKey`, which a shared worker in WebKit can't read back.
 *
 * Gives null, so the node makes a key for one run, where there is no
 * IndexedDB or no Web Locks: a key two nodes might hold at once is worse
 * than no lasting key.
 *
 * @param name Scopes the slots, e.g. the account's store prefix, so signing
 *   out deletes the keys with the rest.
 */
export function browserWriterKeys(
  name: string,
  provider: CryptoProvider = createP256Provider(),
): WriterKeySource {
  return Object.freeze({
    async claim(): Promise<ClaimedWriter | null> {
      const locks = globalThis.navigator?.locks;
      if (!locks || !globalThis.indexedDB) return null;
      for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
        const dbName = `${name}:writer:${slot}`;
        const unlock = await tryLock(locks, dbName);
        if (!unlock) continue;
        try {
          return await openSlot(dbName, unlock, provider);
        } catch {
          // This slot's storage won't open; another may, or the node goes without.
          unlock();
        }
      }
      return null;
    },
  });
}

/** The key in a slot this node holds the lock to, made if there is none */
async function openSlot(
  dbName: string,
  unlock: () => void,
  provider: CryptoProvider,
): Promise<ClaimedWriter> {
  const run = await slotStore(dbName);
  const kept: unknown = await run('readonly', (store) => store.get(KEY_SEED));
  const seed = kept instanceof Uint8Array ? kept : globalThis.crypto.getRandomValues(new Uint8Array(32));
  if (seed !== kept) {
    // A new key starts new lines: whatever a forgotten one left goes.
    await run('readwrite', (store) => store.clear());
    await run('readwrite', (store) => store.put(seed, KEY_SEED));
  }
  const keys = await provider.deriveKeyPairFromSeed(seed);
  const heads: HeadStore = {
    async get(key) {
      const value = await run('readonly', (store) => store.get(`head:${key}`));
      return value instanceof Uint8Array ? value : null;
    },
    async put(key, value) {
      await run('readwrite', (store) => store.put(value, `head:${key}`));
    },
  };
  return Object.freeze({
    keys,
    heads,
    async release() {
      run.close();
      unlock();
    },
    async forget() {
      // The key only: its places stay while it may still sign, until the next claim.
      await run('readwrite', (store) => store.delete(KEY_SEED));
    },
  });
}

/**
 * Runs requests on a slot's database. The browser can close the connection
 * under a running node; it is opened again only while the slot still holds
 * the key, since one emptied (site data cleared) has lost the key's places.
 */
async function slotStore(dbName: string) {
  let db = await openDb(dbName, STORE);
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) => {
    try {
      return await idbRun(db, STORE, mode, fn);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error;
      db = await openDb(dbName, STORE);
      const kept: unknown = await idbRun(db, STORE, 'readonly', (store) => store.get(KEY_SEED));
      if (!(kept instanceof Uint8Array))
        throw new Error('This site’s data was cleared while the page was open. Reload the page.');
      return idbRun(db, STORE, mode, fn);
    }
  };
  return Object.assign(run, { close: () => db.close() });
}
