/**
 * Making a shared folder converge without anybody taking a lock.
 *
 * Two origins, or two devices behind a sync service, can write one folder at
 * once. Version files are named by their content hash, so they never
 * conflict; the entries saying which version is current can be lost to a
 * race, but they are derived from the files. So **the set of version files
 * wins**: reconciling places every file that turned up and drops entries
 * whose file went away.
 */

import type { StorageProvider } from './storage-provider.js';
import type { FolderAdapter } from './folder-adapter.js';
import type { Version } from '../types.js';

/** What a pass over the folder found */
export interface FolderReconciliation {
  /** Version files that appeared since the last pass — another origin's writes */
  readonly added: ReadonlyArray<string>;
  /** Version files that are gone */
  readonly removed: ReadonlyArray<string>;
  /** Versions placed or unplaced to match the directory */
  readonly repaired: ReadonlyArray<string>;
  /** Whether anything moved at all — worth a re-render when true */
  readonly changed: boolean;
}

/**
 * Re-reads the folder and brings the entries back in line with it. With
 * nothing new on disk it is two listings and no writes.
 *
 * @param accept Whether a version found on disk may be placed: anyone who can
 *   write the folder can drop a file in it. One refused now is asked about again.
 */
export async function reconcileFolder(
  storage: StorageProvider,
  adapter: FolderAdapter,
  accept: (version: Version) => Promise<boolean> = async () => true,
): Promise<FolderReconciliation> {
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
 * Places files not indexed yet, and those that just appeared even if they
 * are: placing is idempotent and corrects a current entry a race left wrong.
 */
async function placeNew(
  storage: StorageProvider,
  adapter: FolderAdapter,
  onDisk: Set<string>,
  appeared: Set<string>,
  accept: (version: Version) => Promise<boolean>,
): Promise<string[]> {
  const indexed = new Set(await storage.versionIds());
  const placed: string[] = [];
  for (const id of onDisk) {
    if (indexed.has(id) && !appeared.has(id)) continue;
    // A file can vanish between listing and reading; the next pass agrees.
    const version = await adapter.getVersion(id);
    if (!version || !(await accept(version))) continue;
    await storage.addVersion(version);
    placed.push(id);
  }
  return placed;
}

/** Drops entries whose file another writer superseded and deleted */
async function dropGone(
  storage: StorageProvider,
  adapter: FolderAdapter,
  onDisk: Set<string>,
): Promise<string[]> {
  const gone = (await storage.versionIds()).filter((id) => !onDisk.has(id));
  for (const id of gone) {
    if (!(await adapter.getVersion(id))) await storage.removeVersion(id);
  }
  return gone;
}
