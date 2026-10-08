/**
 * @module node/writer-keys
 * A signing key that outlives the node, held by one node at a time.
 *
 * Every key's writes in a space form one line (spec 02 §4.10). A node that
 * makes a new key each time it starts begins a new line each time; one that
 * keeps its key keeps one line for as long as the device does. But a kept key
 * must never sign in two places at once, or its line forks and everything it
 * signed from there stops counting. So a key is kept in a **slot**, and a node
 * claims a slot under a lock: another tab, worker or process that finds the
 * slot taken claims the next one. A key's places in its log are kept in the
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
  /** Forgets the key, so the slot's next claim makes a new one: for a key that was revoked */
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
 * the Web Locks API across tabs and workers. The private key is
 * non-extractable: a script that gets into the page can sign with it while it
 * runs, but can never take it away.
 *
 * Gives null, so the node makes a key for one run, where there is no
 * IndexedDB or no Web Locks: a key that two nodes might hold at once is worse
 * than no lasting key.
 *
 * @param name Scopes the slots, e.g. the account's store prefix. Signing out
 *   deletes every database under that prefix, and the keys with them.
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
          const db = await openDb(dbName, STORE);
          let keys = await idbRun(db, STORE, 'readonly', (store) => store.get(KEYS));
          if (!isKeyPair(keys)) {
            const made = await provider.generateKeyPair();
            keys = { publicKey: made.publicKey, privateKey: made.privateKey };
            await idbRun(db, STORE, 'readwrite', (store) => store.put(keys, KEYS));
          }
          if (!isKeyPair(keys)) throw new Error('The writer key could not be kept');
          const heads: HeadStore = {
            async get(key) {
              const value = await idbRun(db, STORE, 'readonly', (store) => store.get(`head:${key}`));
              return value instanceof Uint8Array ? value : null;
            },
            async put(key, value) {
              await idbRun(db, STORE, 'readwrite', (store) => store.put(value, `head:${key}`));
            },
          };
          return Object.freeze({
            keys,
            heads,
            async release() {
              db.close();
              unlock();
            },
            async forget() {
              await idbRun(db, STORE, 'readwrite', (store) => store.clear());
            },
          });
        } catch {
          // This slot's storage won't open; another may, or the node goes without.
          unlock();
        }
      }
      return null;
    },
  });
}
