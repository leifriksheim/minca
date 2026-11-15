import { createEncryptedAdapter, type StoreFactory, type StoreOptions } from '@minca/core';
import { hasIndexedDB, indexedDBStores } from '../indexeddb/stores.js';
import { createFolderAdapter, type DirectoryHandleLike } from './adapter.js';
import { createDirectoryBlobStore } from './blob-store.js';

/**
 * Stores in a directory on this device, one file per entry and per version.
 * A data folder others share is {@link folderStores}.
 * @param options.localKey Seals the registry. Without it nothing is sealed.
 * @param options.shared Others write these stores too, and nothing reloads them: read from the disk each time.
 */
export function directoryStores(
  directory: DirectoryHandleLike,
  options: { readonly localKey?: CryptoKey | null; readonly shared?: boolean } = {},
): StoreFactory {
  return async (path, storeOptions) => {
    const adapter = await createFolderAdapter(directory, path, { shared: options.shared ?? false });
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
  if (!options.local && !hasIndexedDB())
    throw new Error('A data folder needs `local`, somewhere outside it for this device’s own stores.');
  const local =
    options.local ?? indexedDBStores(`minca-pod:${(options.basePath ?? 'folder').replace(/\//g, ':')}`);
  // Every app and device of the account writes the registry, and nothing reloads it.
  const registry = directoryStores(directory, { localKey: options.localKey ?? null, shared: true });
  const factory = (path: string, storeOptions?: StoreOptions) =>
    path === 'registry' ? registry(at(path), storeOptions) : local(path, storeOptions);
  return Object.assign(factory, { folder: createDirectoryBlobStore(directory, at(SEGMENTS)) });
}
