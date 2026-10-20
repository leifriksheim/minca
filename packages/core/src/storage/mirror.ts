/**
 * A space kept in a dumb file store, synced like a peer that never runs code.
 *
 * ```
 * <space-id>/
 *   <writer-id>/000001-<hash>.seg     immutable: written once, never changed
 *   <writer-id>/000002-<hash>.seg
 *   <other writer>/…
 * ```
 *
 * A **writer** is one store on one device — a browser's database, a host —
 * with a random id of its own. It only ever creates files in its own folder,
 * so nothing is written twice, nothing is overwritten, and nothing needs a
 * lock. A segment holds versions exactly as they travel; each reader builds
 * its own tree from them. Merging is the protocol's own: the set of versions
 * only grows, and the version rule picks the same current one everywhere.
 *
 * **Push**: versions this store holds that the store is not known to hold go
 * out in a new segment. "Known" is everything this writer uploaded or read,
 * so nobody re-uploads everyone else's records.
 *
 * **Pull**: segments not read yet are fetched once, and every version in them
 * goes through the same gates as one from a peer — the store is untrusted.
 * It can hide things (the mesh fills the gap) but not forge them.
 *
 * **Compaction**: a writer may rewrite its own segments into fewer, keeping
 * only what its store still keeps, then delete the old ones. New first,
 * delete after: a reader in between sees duplicates, which are harmless.
 */
import type { Version, StorageAdapter } from '../types.js';
import type { BlobStore } from './blob-store.js';
import type { StorageProvider } from './storage-provider.js';
import {
  isWholeSegment,
  packSegment,
  segmentBatches,
  segmentName,
  SEGMENT_SUFFIX,
  unpackSegment,
} from './segment.js';
import { isStub } from '../schema/version.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { unref } from '../utils/guards.js';

/** What became of a version handed over from the store */
export type Taken = 'stored' | 'later' | 'refused';

export interface MirrorConfig {
  readonly store: BlobStore;
  readonly space: string;
  readonly storage: StorageProvider;
  /** The gates sync uses, and storing what passes: nothing from the store is trusted more than a peer */
  readonly accept: (version: Version) => Promise<Taken>;
  /**
   * Where this writer keeps its id, what it read and what it knows the store
   * holds. Never in the blob store: two devices sharing one id would each
   * skip the other's segments as their own.
   */
  readonly state: StorageAdapter;
  /** Pack a segment once this much is waiting. Default 256 KiB. */
  readonly flushBytes?: number;
  /** Or this long after the first change. Default 5 s. */
  readonly flushMs?: number;
  /** Rewrite this writer's segments once it has this many. Default 32. */
  readonly compactAt?: number;
}

export interface Mirror {
  /** Takes in what others left in the store. How many versions were stored. */
  pull(): Promise<{ readonly added: number }>;
  /** Uploads what the store is missing, now */
  flush(): Promise<void>;
  /** Something changed here: flush soon */
  changed(): void;
  /** Rewrites this writer's segments into fewer */
  compact(): Promise<void>;
  /** Flushes, and stops the timer */
  close(): Promise<void>;
}

const WRITER_KEY = 'mirror:writer';
const COUNTER_KEY = 'mirror:counter';
const readKey = (name: string) => `mirror:read:${name}`;
const knownKey = (id: string) => `mirror:known:${id}`;
const MARK = utf8Encode('1');

/** A new store writer id: 128 random bits as hex, never a DID, so a listing does not say whose device wrote it */
const newWriterId = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** Deletes everything a space keeps in a store — every writer's segments */
export async function deleteMirrored(store: BlobStore, space: string): Promise<void> {
  for (const key of await store.list(`${space}/`)) await store.delete(key);
}

export async function createMirror(config: MirrorConfig): Promise<Mirror> {
  const { store, space, storage, state } = config;
  const flushBytes = config.flushBytes ?? 256 * 1024;
  const flushMs = config.flushMs ?? 5000;
  const compactAt = config.compactAt ?? 32;
  /** How many segments the last compaction left, so the next waits for twice that */
  let left = 0;

  let writerBytes = await state.get(WRITER_KEY);
  if (!writerBytes) {
    writerBytes = utf8Encode(newWriterId());
    await state.put(WRITER_KEY, writerBytes);
  }
  const writer = utf8Decode(writerBytes);
  const mine = `${space}/${writer}/`;

  const counterBytes = await state.get(COUNTER_KEY);
  let counter = counterBytes ? Number(utf8Decode(counterBytes)) : 0;

  // Read once: a flush asks about every version the store keeps, and a folder flushes every second.
  const known = new Set((await state.list(knownKey(''))).map((key) => key.slice(knownKey('').length)));
  const markKnown = async (id: string) => {
    if (known.has(id)) return;
    await state.put(knownKey(id), MARK);
    known.add(id);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** One upload or compaction at a time: two at once would pack the same versions twice */
  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = busy.then(work, work);
    busy = next.catch(() => {});
    return next;
  };

  async function writeSegment(versions: ReadonlyArray<Version>): Promise<string> {
    const bytes = packSegment(versions);
    counter += 1;
    const name = `${mine}${await segmentName(counter, bytes)}`;
    await store.put(name, bytes);
    await state.put(COUNTER_KEY, utf8Encode(String(counter)));
    await state.put(readKey(name), MARK);
    return name;
  }

  /** Writes versions in segments of about `flushBytes`, telling `written` each one */
  async function writeSegments(
    versions: Iterable<Version>,
    written: (batch: ReadonlyArray<Version>) => Promise<void> = async () => {},
  ): Promise<void> {
    for (const batch of segmentBatches(versions, flushBytes)) {
      await writeSegment(batch);
      await written(batch);
    }
  }

  async function flushNow(): Promise<void> {
    // Every version this store keeps: whole if current or retained, as a stub otherwise.
    const waiting: Version[] = [];
    for (const id of await storage.versionIds()) {
      if (known.has(id)) continue;
      const version = await storage.getVersion(id);
      if (version) waiting.push(version);
    }
    await writeSegments(waiting, async (batch) => {
      for (const version of batch) await markKnown(version.id);
    });
    // Past what the last compaction left times two: a space bigger than `compactAt` segments
    // would otherwise be rewritten whole on every flush, and read again by every other reader.
    if (
      (await store.list(mine)).filter((key) => key.endsWith(SEGMENT_SUFFIX)).length >=
      Math.max(compactAt, 2 * left)
    )
      await compactNow();
  }

  async function compactNow(): Promise<void> {
    const old = (await store.list(mine)).filter((key) => key.endsWith(SEGMENT_SUFFIX));
    if (old.length < 2) return;
    const keep = new Map<string, Version>();
    for (const key of old) {
      const bytes = await store.get(key).catch(() => null);
      // The store's copy: a version superseded since it was written is a stub
      // now, and its body is not carried forward. One the store does not hold
      // (asked of it afresh, so another process's write to it is found) was put
      // there by someone else, and goes.
      for (const version of bytes ? unpackSegment(bytes) : []) {
        const held = keep.has(version.id) ? null : await storage.getVersion(version.id);
        if (held) keep.set(version.id, held);
      }
    }
    // New first, then delete: a reader in between sees each version twice, which is harmless.
    let written = 0;
    await writeSegments(keep.values(), async () => {
      written += 1;
    });
    for (const key of old) await store.delete(key);
    left = written;
  }

  async function pullNow(): Promise<{ added: number }> {
    const fresh: string[] = [];
    for (const key of await store.list(`${space}/`)) {
      // Our own segments hold what we uploaded; a listing that lags is trusted less than our own writes.
      if (!key.endsWith(SEGMENT_SUFFIX) || key.startsWith(mine) || (await state.get(readKey(key)))) continue;
      fresh.push(key);
    }
    let added = 0;
    for (const key of fresh.sort()) {
      // One segment that can't be fetched must not keep every one after it out: it is tried again next time.
      const bytes = await store.get(key).catch(() => null);
      // Deleted between listing and fetching — compacted by its writer. Its versions are in a newer segment.
      // Or not all there yet (still being written, half synced): read again next time.
      if (!bytes || !(await isWholeSegment(key, bytes))) continue;
      let pending = unpackSegment(bytes);
      // Versions can depend on each other — a record on its first version, on the access changes it saw.
      // Pass over the rest until nothing more goes in.
      for (let progress = true; pending.length > 0 && progress;) {
        progress = false;
        const later: Version[] = [];
        for (const version of pending) {
          const taken = await config.accept(version);
          if (taken === 'later') {
            later.push(version);
            continue;
          }
          // A refused copy is not known to be there: the valid one with the same id may still need pushing.
          if (taken === 'stored') {
            added += 1;
            // Nor is a stub of one held whole: the whole one still goes out.
            const held = isStub(version) ? await storage.getVersion(version.id) : null;
            if (!held || isStub(held)) await markKnown(version.id);
          }
          progress = true;
        }
        pending = later;
      }
      // Some still waiting on something no segment here has: read again next time.
      if (pending.length === 0) await state.put(readKey(key), MARK);
    }
    return { added };
  }

  return Object.freeze({
    pull: () => serial(pullNow),
    flush: () => serial(flushNow),
    compact: () => serial(compactNow),

    changed() {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void serial(flushNow).catch(() => {
          // The store is out of reach; the next change tries again, and nothing is lost meanwhile.
        });
      }, flushMs);
      unref(timer);
    },

    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await serial(flushNow).catch(() => {});
    },
  });
}
