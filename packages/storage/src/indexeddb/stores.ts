import type { StoreFactory } from '@minca/core';
import { createIndexedDBAdapter } from './adapter.js';

/**
 * Stores in this origin's IndexedDB, one database per path. Not sealed: the
 * browser profile already keeps the files from anyone else.
 * @param prefix Namespaces the databases, e.g. an app and account id
 */
export function indexedDBStores(prefix: string): StoreFactory {
  return (path) => createIndexedDBAdapter(`${prefix}:${path.replace(/\//g, ':')}`);
}

/** Whether this runtime has IndexedDB, key ranges included: the adapter lists by them, and a stand-in may lack them */
export const hasIndexedDB = (): boolean =>
  typeof globalThis.indexedDB !== 'undefined' && typeof globalThis.IDBKeyRange !== 'undefined';
