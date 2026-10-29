/**
 * @module node/stores
 * Where a node keeps its data.
 *
 * A node asks for its stores by path — `registry`, `spaces/<id>`, `writers` —
 * and a {@link StoreFactory} decides what a path means: a database in this
 * browser, files on a disk, or a data folder.
 */
import type { StorageAdapter } from '../types.js';
import { createIndexedDBAdapter } from '../storage/indexeddb-adapter.js';
import { createFolderAdapter, type DirectoryHandleLike } from '../storage/folder-adapter.js';
import { createEncryptedAdapter } from '../storage/encrypted-adapter.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createDirectoryBlobStore } from '../storage/blob/directory.js';
import { browserWriterKeys, type WriterKeySource } from './writer-keys.js';

export interface StoreOptions {
  /** Encrypt at rest. The node sets it for the registry, which holds every private space's key. */
  readonly seal?: boolean;
}

/** Opens the store for a `/`-separated path. Over a data folder, `folder` is where spaces are mirrored (spec 05 §14). */
export type StoreFactory = ((path: string, options?: StoreOptions) => Promise<StorageAdapter>) & {
  readonly folder?: BlobStore;
};

/**
 * Stores in this origin's IndexedDB, one database per path. Not sealed: the
 * browser profile already keeps the files from anyone else.
 * @param prefix Namespaces the databases, e.g. an app and account id
 */
export function indexedDBStores(prefix: string): StoreFactory {
  return (path) => createIndexedDBAdapter(`${prefix}:${path.replace(/\//g, ':')}`);
}

/**
 * Stores in a directory on this device, one file per entry and per version.
 * A data folder others share is {@link folderStores}.
 * @param options.localKey Seals the registry. Without it nothing is sealed.
 */
export function directoryStores(
  directory: DirectoryHandleLike,
  options: { readonly localKey?: CryptoKey | null } = {},
): StoreFactory {
  return async (path, storeOptions) => {
    const adapter = await createFolderAdapter(directory, path);
    return storeOptions?.seal && options.localKey
      ? createEncryptedAdapter(adapter, options.localKey)
      : adapter;
  };
}

/** A data folder's segments sit beside the registry, under `spaces/` (spec 05 §14.1) */
const SEGMENTS = 'spaces';

/**
 * Stores in a data folder several apps and devices share (spec 05 §14).
 *
 * The folder holds the registry, sealed, and each space as segments, the way
 * a mirror keeps one in a bucket (`folder`). Everything else is this device's
 * own, in `local`. Nothing else is read from the folder: whoever can write it
 * could plant a writer id or a key's last place for this device to take.
 *
 * @param options.basePath Where this account's data starts, e.g. `accounts/<id>/stores`
 * @param options.localKey Seals the registry. Without it nothing is sealed.
 * @param options.local Where this device keeps its own stores, outside the
 *   folder. Default: IndexedDB under `minca-pod:<basePath>`. Required without
 *   IndexedDB: in memory, a restart would sign at a place it signed before.
 */
export function folderStores(
  directory: DirectoryHandleLike,
  options: {
    readonly basePath?: string;
    readonly localKey?: CryptoKey | null;
    readonly local?: StoreFactory;
  } = {},
): StoreFactory {
  const at = (path: string) => (options.basePath ? `${options.basePath}/${path}` : path);
  // Key ranges too: the IndexedDB adapter lists by them, and a stand-in may lack them.
  const browser =
    typeof globalThis.indexedDB !== 'undefined' && typeof globalThis.IDBKeyRange !== 'undefined';
  if (!options.local && !browser)
    throw new Error('A data folder needs `local`, somewhere outside it for this device’s own stores.');
  const local =
    options.local ?? indexedDBStores(`minca-pod:${(options.basePath ?? 'folder').replace(/\//g, ':')}`);
  const registry = directoryStores(directory, { localKey: options.localKey ?? null });
  const factory = (path: string, storeOptions?: StoreOptions) =>
    path === 'registry' ? registry(at(path), storeOptions) : local(path, storeOptions);
  return Object.assign(factory, { folder: createDirectoryBlobStore(directory, at(SEGMENTS)) });
}

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
