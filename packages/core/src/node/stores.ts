/**
 * @module node/stores
 * Where a node keeps its data.
 *
 * A node asks for its stores by path — `registry`, `spaces/<id>`, `writers` —
 * and a {@link StoreFactory} decides what a path means: a database in this
 * browser, files on a disk, or a data folder. `@minca/storage` has one for
 * each.
 */
import type { StorageAdapter } from '../types.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { BodyCache } from '../storage/body-cache.js';

export interface StoreOptions {
  /** Encrypt at rest. The node sets it for the registry, which holds every private space's key. */
  readonly seal?: boolean;
}

/**
 * Opens the store for a `/`-separated path. Over a data folder, `folder` is
 * where spaces are mirrored (spec 05 §14). With `cache`, every space's store
 * keeps its version bodies in that one cache; without, each keeps its own.
 */
export type StoreFactory = ((path: string, options?: StoreOptions) => Promise<StorageAdapter>) & {
  readonly folder?: BlobStore;
  readonly cache?: BodyCache;
};
