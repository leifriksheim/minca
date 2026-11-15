/**
 * Making a shared store converge without anybody taking a lock.
 *
 * Two origins, or two devices behind a sync service, can write one folder at
 * once. Versions are named by their content hash, so they never conflict;
 * the entries saying which version is current can be lost to a race, but
 * they are derived from the versions. So **the set of versions wins**:
 * reconciling places every version that turned up and drops entries whose
 * version went away.
 */

import type { StorageProvider } from './storage-provider.js';
import type { SharedStorageAdapter, Version } from '../types.js';

/** What a pass over a shared store found */
export interface Reconciliation {
  /** Versions that appeared since the last pass — another origin's writes */
  readonly added: ReadonlyArray<string>;
  /** Versions that are gone */
  readonly removed: ReadonlyArray<string>;
  /** Versions placed or unplaced to match the store */
  readonly repaired: ReadonlyArray<string>;
  /** Whether anything moved at all — worth a re-render when true */
  readonly changed: boolean;
}

/**
 * Re-reads the store and brings the entries back in line with it. With
 * nothing new it is two listings and no writes.
 *
 * @param accept Whether a version found in the store may be placed: anyone who can
 *   write the store can drop one in it. One refused now is asked about again.
 */
export async function reconcileSharedStore(
  storage: StorageProvider,
  adapter: SharedStorageAdapter,
  accept: (version: Version) => Promise<boolean> = async () => true,
): Promise<Reconciliation> {
  const disk = await adapter.reload();
  const moved = disk.added.length > 0 || disk.removed.length > 0;
  // Sync compares entries, and another writer's are on disk now too.
  if (moved) storage.invalidate();
  const onDisk = new Set(await adapter.listVersionIds());

  const placed = await placeNew(storage, adapter, onDisk, new Set(disk.added), accept);
  const dropped = await dropGone(storage, adapter, onDisk);

  const repaired = [...placed, ...dropped];
  return { added: disk.added, removed: disk.removed, repaired, changed: moved || repaired.length > 0 };
}

/**
 * Places versions not indexed yet, and those that just appeared even if they
 * are: placing is idempotent and corrects a current entry a race left wrong.
 */
async function placeNew(
  storage: StorageProvider,
  adapter: SharedStorageAdapter,
  onDisk: Set<string>,
  appeared: Set<string>,
  accept: (version: Version) => Promise<boolean>,
): Promise<string[]> {
  const indexed = new Set(await storage.versionIds());
  const placed: string[] = [];
  for (const id of onDisk) {
    if (indexed.has(id) && !appeared.has(id)) continue;
    // A version can vanish between listing and reading; the next pass agrees.
    const version = await adapter.getVersion(id);
    if (!version || !(await accept(version))) continue;
    await storage.addVersion(version);
    placed.push(id);
  }
  return placed;
}

/** Drops entries whose version another writer superseded and deleted */
async function dropGone(
  storage: StorageProvider,
  adapter: SharedStorageAdapter,
  onDisk: Set<string>,
): Promise<string[]> {
  const gone = (await storage.versionIds()).filter((id) => !onDisk.has(id));
  for (const id of gone) {
    if (!(await adapter.getVersion(id))) await storage.removeVersion(id);
  }
  return gone;
}
