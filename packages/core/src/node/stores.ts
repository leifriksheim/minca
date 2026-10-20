/**
 * @module node/stores
 * Where a node keeps its data.
 *
 * A node needs a registry listing the spaces it holds (and their keys), one
 * store per space, and one for where its lasting keys are in their logs. It
 * asks for them by path — `registry`, `spaces/<id>`, `writers` — and a
 * {@link StoreFactory} decides what a path
 * means: a database in this browser, a file on a server's disk, or, in a data
 * folder, the registry in the folder and the rest beside this device's copy
 * of what the folder's segments hold.
 */
import type { StorageAdapter } from '../types.js';
import { createIndexedDBAdapter } from '../storage/indexeddb-adapter.js';
import { createFolderAdapter, type DirectoryHandleLike } from '../storage/folder-adapter.js';
import { createEncryptedAdapter } from '../storage/encrypted-adapter.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createDirectoryBlobStore } from '../storage/blob/directory.js';
import { browserWriterKeys, type WriterKeySource } from './writer-keys.js';

export interface StoreOptions {
  /**
   * Encrypt space records and space keys at rest. The node sets it for the
   * registry, the one store whose contents would otherwise hand every private
   * space to whoever copied the files.
   */
  readonly seal?: boolean;
}

/**
 * Opens the store for a `/`-separated path. A factory over a data folder
 * also names the folder's segments (`folder`): every space opened from it is
 * mirrored there, as with any blob store (spec 05 §14).
 */
export type StoreFactory = ((path: string, options?: StoreOptions) => Promise<StorageAdapter>) & {
  readonly folder?: BlobStore;
};

/**
 * Stores in this origin's IndexedDB, one database per path.
 *
 * Not sealed: the browser profile already stands between the data and anyone
 * else, and the threat sealing answers — someone holding the files — does not
 * arise.
 *
 * @param prefix Namespaces the databases, e.g. an app and account id
 */
export function indexedDBStores(prefix: string): StoreFactory {
  return (path) => createIndexedDBAdapter(`${prefix}:${path.replace(/\//g, ':')}`);
}

/**
 * Stores in a directory on this device, one file per entry and per version
 * (`storage/folder-adapter.ts`). A data folder others share is
 * {@link folderStores}.
 *
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
 * Stores in a data folder the person picked: a directory several apps and
 * devices read and write at once (spec 05 §14).
 *
 * Only the registry is kept in the folder as entries, sealed. Every space is
 * kept in it as segments, the way a mirror keeps one in a bucket: the
 * factory's `folder`, which each space runtime opened from it mirrors to.
 * Everything else — a space's entries and bodies, what the node keeps beside
 * them, each mirror's own state — is this device's own, in `local`, so the
 * folder holds a few files per space and device, not several per version.
 *
 * Nothing else is read from the folder, an older layout included: whoever
 * can write it could plant a store writer id, or a key's last place in its
 * line, for this device to take as its own.
 *
 * @param directory The folder
 * @param options.basePath Where this account's data starts, e.g. `accounts/<id>/stores`
 * @param options.localKey Seals the registry. Without it nothing is sealed.
 * @param options.local Where this device keeps its own stores, never inside
 *   the folder. Default: this origin's IndexedDB under `minca-pod:<basePath>`
 *   (not `minca:`, which is an account kept in the browser, and is deleted
 *   when the person forgets that copy). Required where there is no IndexedDB:
 *   in memory, a lasting key's places would be lost, and a restart would sign
 *   at a place it signed before.
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
 * this origin's IndexedDB, under the account's prefix, so signing out
 * deletes it with the rest. Never the data folder, which other apps and
 * devices share: a key there could sign in two places at once. A folder
 * without an account path names no account to keep a key for.
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
