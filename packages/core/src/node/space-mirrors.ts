/**
 * @module node/space-mirrors
 * The copies of a space beside its own store: file stores (`storage/mirror.ts`),
 * the data folder, and other tabs of the same browser.
 *
 * Every mirror is one more peer: what it holds goes through the same gates
 * as a peer's records, and what this node holds goes out to it. A data
 * folder is written by other apps, and by other devices behind whatever
 * syncs it; a directory store by another process (a command beside a
 * daemon). Nothing announces either, so both are looked for.
 */
import type { StorageAdapter, Version } from '../types.js';
import { reconcileFolder } from '../storage/folder-reconcile.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createMirror, type Mirror, type Taken } from '../storage/mirror.js';
import type { FolderAdapter } from '../storage/folder-adapter.js';
import type { StoreFactory } from './stores.js';
import { unref } from '../utils/guards.js';
import { type Standing, storable, type SpaceBase } from './space-versions.js';

export interface MirrorsDeps extends SpaceBase {
  readonly stores: StoreFactory;
  readonly adapter: StorageAdapter;
  readonly mirrors: ReadonlyArray<BlobStore> | undefined;
  readonly watchIntervalMs: number;
  /** Whether a version from outside may be stored, as for a peer's */
  readonly admit: (version: Version) => Promise<Standing>;
  readonly recordsChanged: () => void;
  /** Tells the peers this node took in something new */
  readonly announceSoon: () => void;
}

const isFolderAdapter = (adapter: StorageAdapter): adapter is FolderAdapter =>
  'reload' in adapter && typeof adapter.reload === 'function';

export async function openMirrors(deps: MirrorsDeps) {
  const { space, storage, adapter, admit, recordsChanged, announceSoon } = deps;

  const fromMirror = async (version: Version): Promise<Taken> => {
    const verdict = await admit(version);
    if (!verdict.ok && !verdict.withdrawn) return verdict.later ? 'later' : 'refused';
    await storage.addVersion(version);
    return 'stored';
  };
  const mirrors: Mirror[] = [];
  for (const [index, store] of (deps.mirrors ?? []).entries()) {
    mirrors.push(
      await createMirror({
        store,
        space: space.id,
        storage,
        state: await deps.stores(`mirrors/${space.id}/${index}`),
        accept: fromMirror,
      }),
    );
  }
  // A data folder is one more: its spaces are segments, like a bucket's, and
  // what this device holds of them is its own (`node/stores.ts`).
  const folderMirror = deps.stores.folder
    ? await createMirror({
        store: deps.stores.folder,
        space: space.id,
        storage,
        state: await deps.stores(`folder/${space.id}`),
        accept: fromMirror,
        // Apps and the CLI on one computer meet through the folder: soon, not in a bucket's time.
        flushMs: 1000,
      })
    : null;
  if (folderMirror) mirrors.push(folderMirror);
  /** Reads every mirror in the background: a space that opens from nothing — a host that lost its disk — fills in as it goes */
  const pullMirrors = () =>
    Promise.all(
      mirrors.map((mirror) =>
        mirror
          .pull()
          .then(({ added }) => {
            if (added === 0) return;
            recordsChanged();
            announceSoon();
          })
          .catch(() => {
            // Out of reach now; what this node holds goes out on the next change.
          }),
      ),
    );

  const look = async (): Promise<boolean> => {
    // The same verdict as for a version from a peer.
    const reconciled = isFolderAdapter(adapter)
      ? (await reconcileFolder(storage, adapter, async (version) => storable(await admit(version)))).changed
      : false;
    const pulled = folderMirror ? (await folderMirror.pull()).added > 0 : false;
    return reconciled || pulled;
  };
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let channel: BroadcastChannel | null = null;

  /** Looks for what other writers changed, from now on */
  function watch(): void {
    if (deps.watchIntervalMs > 0 && (folderMirror || isFolderAdapter(adapter))) {
      let running = false;
      watchTimer = setInterval(() => {
        if (running) return;
        running = true;
        look()
          .then((changed) => {
            if (!changed) return;
            recordsChanged();
            announceSoon();
          })
          .catch(() => {
            // A revoked permission or a folder that went away; the next pass will tell.
          })
          .finally(() => {
            running = false;
          });
      }, deps.watchIntervalMs);
    }
    // Tabs of one browser share one IndexedDB but not memory, so a write in one
    // is invisible to the other until it is told. A nudge is enough: the store
    // already holds the data.
    if (typeof globalThis.BroadcastChannel !== 'function') return;
    channel = new globalThis.BroadcastChannel(`minca-node:${deps.rootDid}:${space.id}`);
    channel.onmessage = () => {
      // The other tab wrote to the store underneath: what sync compares is read again.
      storage.invalidate();
      recordsChanged();
    };
    // In Node a channel holds the process open; it must never be the only thing doing so.
    unref(channel);
  }

  return {
    /** Every mirror's store and writer, for files */
    all: () => mirrors.map((mirror) => ({ store: mirror.store, writer: mirror.writer })),
    pull: pullMirrors,
    watch,
    /** Records changed here: soon written to every mirror */
    changed(): void {
      for (const mirror of mirrors) mirror.changed();
    },
    /** Tells the other tabs a write landed in the store they share */
    tellTabs(): void {
      channel?.postMessage('changed');
    },
    /** What this device holds and the folder lacks (copied in, or written before the folder was) goes out soon */
    fillFolder(): void {
      folderMirror?.changed();
    },
    async close(): Promise<void> {
      await Promise.all(mirrors.map((mirror) => mirror.close()));
      if (watchTimer) clearInterval(watchTimer);
      channel?.close();
    },
  };
}
