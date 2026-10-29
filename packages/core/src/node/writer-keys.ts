/**
 * @module node/writer-keys
 * A signing key that outlives the node, held by one node at a time.
 *
 * A key's writes in each collection of a space form one line (spec 02
 * §4.10). A node that makes a new key each time it starts begins new lines
 * each time; one that keeps its key keeps its lines for as long as the device
 * does. But a kept key must never sign in two places at once, or its lines
 * fork and what it signed from the fork on stops counting. So a key is kept
 * in a **slot**, claimed under a lock: a tab, worker or process that finds
 * the slot taken claims the next one. A key's places in its log are kept in the
 * slot with it — never in the account's stores, which may be a folder shared,
 * copied or restored elsewhere.
 */
import { createP256Provider } from '../identity/crypto-p256.js';
import { idbRun, openDb } from '../identity/idb.js';
import { isRecord } from '../utils/guards.js';
import type { CryptoProvider } from '../types.js';

/** Where a lasting key's places in its logs are kept: beside the key */
export interface HeadStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
}

/** A key this node alone signs with, until it lets go */
export interface ClaimedWriter {
  readonly keys: CryptoKeyPair;
  readonly heads: HeadStore;
  /** Lets another node claim the slot. The node calls it when it closes. */
  release(): Promise<void>;
  /**
   * Forgets the key, so the slot's next claim makes a new one: for a key that
   * was revoked. Its places stay until then, so it may still sign this run.
   */
  forget(): Promise<void>;
}

/**
 * Where a node gets a lasting key. `claim` gives a key no one else is
 * signing with now, or null when it can't promise that — then the node makes
 * a key for this run alone, as it would without a source.
 */
export interface WriterKeySource {
  claim(): Promise<ClaimedWriter | null>;
}

/** How many slots one account keeps in one browser: one per tab or worker signing at once */
const MAX_SLOTS = 32;
const STORE = 'writer';
const KEYS = 'keys';

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

const isKeyPair = (value: unknown): value is CryptoKeyPair =>
  isRecord(value) && value.privateKey instanceof CryptoKey && value.publicKey instanceof CryptoKey;

/**
 * Lasting keys in this origin's IndexedDB, one database per slot, locked with
 * Web Locks across tabs and workers. The private key is non-extractable: a
 * script in the page can sign with it while it runs, never take it away.
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
  let keys: unknown = await run('readonly', (store) => store.get(KEYS));
  if (!isKeyPair(keys)) {
    const made = await provider.generateKeyPair();
    keys = { publicKey: made.publicKey, privateKey: made.privateKey };
    // A new key starts new lines: whatever a forgotten one left goes.
    await run('readwrite', (store) => store.clear());
    await run('readwrite', (store) => store.put(keys, KEYS));
  }
  if (!isKeyPair(keys)) throw new Error('The writer key could not be kept');
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
      await run('readwrite', (store) => store.delete(KEYS));
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
      if (!isKeyPair(await idbRun(db, STORE, 'readonly', (store) => store.get(KEYS))))
        throw new Error('This site’s data was cleared while the page was open. Reload the page.');
      return idbRun(db, STORE, mode, fn);
    }
  };
  return Object.assign(run, { close: () => db.close() });
}
