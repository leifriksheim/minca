import type { StoreFactory, WriterKeySource } from '@minca/core';
import { browserWriterKeys, indexedDBStores } from '@minca/storage/indexeddb';
import { folderStores, type DirectoryHandleLike } from '@minca/storage/folder';

/** Where a node in a worker keeps its data, said as data: a store factory can't be sent */
export type WorkerStores =
  /** This origin's IndexedDB, under a prefix (`indexedDBStores`) */
  | { readonly indexedDB: string }
  /** A data folder the person picked (`folderStores`), with this origin's IndexedDB beside it */
  | {
      readonly directory: DirectoryHandleLike;
      readonly basePath?: string;
      readonly localKey?: CryptoKey | null;
    };

/**
 * Where a node started from a description keeps its lasting writer key:
 * IndexedDB under the account's prefix, so signing out deletes it. Never the
 * shared data folder, where it could sign in two places at once.
 */
export function writerKeysFor(stores: WorkerStores): WriterKeySource | undefined {
  if ('indexedDB' in stores) return browserWriterKeys(stores.indexedDB);
  return stores.basePath ? browserWriterKeys(`minca:${stores.basePath.replace(/\//g, ':')}`) : undefined;
}

/** The store factory a description stands for */
export function workerStores(stores: WorkerStores): StoreFactory {
  return 'indexedDB' in stores
    ? indexedDBStores(stores.indexedDB)
    : folderStores(stores.directory, {
        ...(stores.basePath !== undefined ? { basePath: stores.basePath } : {}),
        ...(stores.localKey ? { localKey: stores.localKey } : {}),
      });
}
