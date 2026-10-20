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
import type { StorageAdapter, Version } from '../types.js';
import { createIndexedDBAdapter } from '../storage/indexeddb-adapter.js';
import {
  createFolderAdapter,
  decodeKey,
  encodeKey,
  readFolderFile,
  removeFile,
  type DirectoryHandleLike,
} from '../storage/folder-adapter.js';
import { createEncryptedAdapter } from '../storage/encrypted-adapter.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createDirectoryBlobStore } from '../storage/blob/directory.js';
import { createMemoryAdapter } from '../storage/memory-adapter.js';
import { packSegment, segmentBatches, segmentName } from '../storage/segment.js';
import { newWriterId } from '../storage/mirror.js';
import { utf8Decode } from '../utils/encoding.js';
import { isStoredVersion } from '../utils/guards.js';
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
 * Stores in a directory, one file per entry and per version
 * (`storage/folder-adapter.ts`). For a directory only this process writes; a
 * data folder others share is {@link folderStores}.
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

/** Stores in memory, kept while the factory is: gone when the process ends */
function memoryStores(): StoreFactory {
  const adapters = new Map<string, StorageAdapter>();
  return async (path) => {
    let adapter = adapters.get(path);
    if (!adapter) adapters.set(path, (adapter = createMemoryAdapter()));
    // Closing a space must not wipe what it wrote.
    return { ...adapter, close: async () => {} };
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
 * A space store in the folder's former layout (`spaces/<id>/kv`, `versions`)
 * is turned into a segment when the space is first opened, then removed; the
 * segment's versions are judged like any other. Another store there (`writers`)
 * is copied into `local` while that is empty, and left: another app sharing
 * the folder may need it too.
 *
 * @param directory The folder
 * @param options.basePath Where this account's data starts, e.g. `accounts/<id>/stores`
 * @param options.localKey Seals the registry. Without it nothing is sealed.
 * @param options.local Where this device keeps its own stores. Default: this
 *   origin's IndexedDB under `minca-pod:<basePath>`, or memory where there is
 *   none. Not `minca:`, which is an account kept in the browser, and is
 *   deleted when the person forgets that copy.
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
  const local =
    options.local ??
    // Key ranges too: the IndexedDB adapter lists by them, and a stand-in may lack them.
    (typeof globalThis.indexedDB === 'undefined' || typeof globalThis.IDBKeyRange === 'undefined'
      ? memoryStores()
      : indexedDBStores(`minca-pod:${(options.basePath ?? 'folder').replace(/\//g, ':')}`));
  const folder = createDirectoryBlobStore(directory, at(SEGMENTS));
  const factory = async (path: string, storeOptions?: StoreOptions) => {
    if (path === 'registry') {
      const adapter = await createFolderAdapter(directory, at(path));
      return storeOptions?.seal && options.localKey
        ? createEncryptedAdapter(adapter, options.localKey)
        : adapter;
    }
    const store = await local(path, storeOptions);
    await adoptFormerStore(directory, at(path), path, store, folder);
    return store;
  };
  return Object.assign(factory, { folder });
}

/** The directory a store had in the folder's former layout, if it is still there */
async function formerStore(
  directory: DirectoryHandleLike,
  path: string,
): Promise<DirectoryHandleLike | null> {
  let dir = directory;
  for (const name of path.split('/').filter(Boolean).map(encodeKey)) {
    const next = await childDir(dir, name);
    if (!next) return null;
    dir = next;
  }
  return (await childDir(dir, 'kv')) || (await childDir(dir, 'versions')) ? dir : null;
}

async function childDir(dir: DirectoryHandleLike, name: string): Promise<DirectoryHandleLike | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

/** Every file in a directory, by decoded name */
async function readAll(dir: DirectoryHandleLike | null): Promise<Array<[string, Uint8Array]>> {
  const files: Array<[string, Uint8Array]> = [];
  if (!dir) return files;
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || entry.name.endsWith('.tmp')) continue;
    const bytes = await readFolderFile(dir, entry.name);
    if (bytes) files.push([decodeKey(entry.name), bytes]);
  }
  return files;
}

/** Brings a store over from the folder's former layout (see {@link folderStores}) */
async function adoptFormerStore(
  directory: DirectoryHandleLike,
  full: string,
  path: string,
  store: StorageAdapter,
  folder: BlobStore,
): Promise<void> {
  const former = await formerStore(directory, full);
  if (!former) return;
  const space = /^spaces\/([^/]+)$/.exec(path)?.[1];
  if (space) {
    const versions: Version[] = [];
    for (const [, bytes] of await readAll(await childDir(former, 'versions'))) {
      try {
        const parsed: unknown = JSON.parse(utf8Decode(bytes));
        if (isStoredVersion(parsed)) versions.push(parsed);
      } catch {
        // Half-written: it never counted.
      }
    }
    // A store writer of its own, never this device's: its own segments are
    // skipped when pulling, and these must be judged like anyone else's.
    const writer = newWriterId();
    let counter = 0;
    for (const batch of segmentBatches(versions, 256 * 1024)) {
      const bytes = packSegment(batch);
      await folder.put(`${space}/${writer}/${await segmentName(++counter, bytes)}`, bytes);
    }
    // Segments first, then delete: in between, the versions are only twice in the folder.
    await removeFile(former, 'kv', true);
    await removeFile(former, 'versions', true);
    return;
  }
  if ((await store.list('')).length > 0) return;
  const entries = await readAll(await childDir(former, 'kv'));
  if (entries.length > 0)
    await store.batch(entries.map(([key, value]) => ({ type: 'put' as const, key, value })));
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
