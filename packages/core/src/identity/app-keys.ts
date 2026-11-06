/**
 * @module identity/app-keys
 * Where an app keeps its keys in a browser: one IndexedDB database of this
 * origin, a key pair by name, never exportable. The page makes them
 * (`appKey`); a node's worker reads them by name itself, since WebKit drops,
 * without an error, a message to a shared worker that holds a `CryptoKey`.
 */
import { idbOnce } from './idb.js';
import { isObject } from '../utils/guards.js';

const KEY_DB = 'minca-app-key';
const STORE = 'keys';

/** The key pair kept under `name`, or null */
export async function readAppKeys(name: string): Promise<CryptoKeyPair | null> {
  const stored = await idbOnce(KEY_DB, STORE, 'readonly', (store) => store.get(name));
  return isKeyPair(stored) ? stored : null;
}

export async function keepAppKeys(name: string, keys: CryptoKeyPair): Promise<void> {
  await idbOnce(KEY_DB, STORE, 'readwrite', (store) => store.put(keys, name));
}

export async function dropAppKeys(name: string): Promise<void> {
  await idbOnce(KEY_DB, STORE, 'readwrite', (store) => store.delete(name));
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  return isObject(value) && value.privateKey instanceof CryptoKey && value.publicKey instanceof CryptoKey;
}
