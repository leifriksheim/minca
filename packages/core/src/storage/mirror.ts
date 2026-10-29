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
import { bytesToHex, utf8Decode, utf8Encode } from '../utils/encoding.js';
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
  /** The blob store, and this store writer's id in it: where its files go too (spec 05 §16.6) */
  readonly store: BlobStore;
  readonly writer: string;
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

/** What this writer keeps in its own state */
const keys = {
  writer: 'mirror:writer',
  counter: 'mirror:counter',
  read: (segment: string) => `mirror:read:${segment}`,
  known: (id = '') => `mirror:known:${id}`,
};
const MARK = utf8Encode('1');

/** A new store writer id: random hex, never a DID, so a listing does not say whose device wrote it */
const newWriterId = () => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

const isSegment = (key: string) => key.endsWith(SEGMENT_SUFFIX);

/** Deletes everything a space keeps in a store — every writer's segments, and its files */
export async function deleteMirrored(store: BlobStore, space: string): Promise<void> {
  const keys = [...(await store.list(`${space}/`)), ...(await store.list(`files/${space}/`))];
  for (const key of keys) await store.delete(key);
}

export async function createMirror(config: MirrorConfig): Promise<Mirror> {
  const { store, space, storage, state } = config;
  const flushBytes = config.flushBytes ?? 256 * 1024;
  const flushMs = config.flushMs ?? 5000;
  const compactAt = config.compactAt ?? 32;

  const writer = await readOrCreate(state, keys.writer, newWriterId);
  const mine = `${space}/${writer}/`;
  let counter = Number((await readText(state, keys.counter)) ?? 0);
  /** How many segments the last compaction left, so the next waits for twice that */
  let left = 0;
  /** The versions the store is known to hold; read once, since every flush asks about all of them */
  const known = await loadKnown();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** One upload or compaction at a time: two at once would pack the same versions twice */
  const serial = queue();

  async function loadKnown(): Promise<Set<string>> {
    const prefix = keys.known();
    const ids = new Set((await state.list(prefix)).map((key) => key.slice(prefix.length)));
    // Known versions, yet the space is gone from the store (`deleteMirrored`): everything goes out
    // again. A store out of reach right now leaves what it knows as it was.
    const gone = ids.size > 0 && (await store.list(`${space}/`).catch(() => null))?.length === 0;
    if (!gone) return ids;
    for (const id of ids) await state.delete(keys.known(id));
    return new Set();
  }

  async function markKnown(id: string): Promise<void> {
    if (known.has(id)) return;
    await state.put(keys.known(id), MARK);
    known.add(id);
  }

  const mySegments = async () => (await store.list(mine)).filter(isSegment);

  async function writeSegment(versions: ReadonlyArray<Version>): Promise<void> {
    const bytes = packSegment(versions);
    counter += 1;
    const name = `${mine}${await segmentName(counter, bytes)}`;
    await store.put(name, bytes);
    await state.put(keys.counter, utf8Encode(String(counter)));
    await state.put(keys.read(name), MARK);
  }

  /** Writes versions in segments of about `flushBytes`; how many segments that took */
  async function writeSegments(
    versions: Iterable<Version>,
    written: (batch: ReadonlyArray<Version>) => Promise<void> = async () => {},
  ): Promise<number> {
    let count = 0;
    for (const batch of segmentBatches(versions, flushBytes)) {
      await writeSegment(batch);
      await written(batch);
      count += 1;
    }
    return count;
  }

  async function flushNow(): Promise<void> {
    const unknown = (await storage.versionIds()).filter((id) => !known.has(id));
    const waiting = (await Promise.all(unknown.map((id) => storage.getVersion(id)))).filter(
      (version) => version !== null,
    );
    await writeSegments(waiting, async (batch) => {
      for (const version of batch) await markKnown(version.id);
    });
    // Twice what the last compaction left, or a big space would be rewritten whole on every flush.
    if ((await mySegments()).length >= Math.max(compactAt, 2 * left)) await compactNow();
  }

  async function compactNow(): Promise<void> {
    const old = await mySegments();
    if (old.length < 2) return;
    // What this store holds now: a version superseded since is a stub, and one it never held
    // was put there by someone else and goes.
    const keep = new Map<string, Version>();
    for (const key of old) {
      for (const version of (await fetchSegment(key)) ?? []) {
        if (keep.has(version.id)) continue;
        const held = await storage.getVersion(version.id);
        if (held) keep.set(version.id, held);
      }
    }
    // New first, then delete: a reader in between sees each version twice, which is harmless.
    left = await writeSegments(keep.values());
    for (const key of old) await store.delete(key);
  }

  /** The segments other writers left that this one has not read in full */
  async function unreadSegments(): Promise<string[]> {
    const unread: string[] = [];
    for (const key of await store.list(`${space}/`)) {
      if (!isSegment(key) || key.startsWith(mine)) continue;
      if (!(await state.get(keys.read(key)))) unread.push(key);
    }
    return unread.sort();
  }

  /** A segment's versions; null if it can't be had, or isn't all there yet, so it is tried next time */
  async function fetchSegment(key: string): Promise<Version[] | null> {
    const bytes = await store.get(key).catch(() => null);
    if (!bytes || !(await isWholeSegment(key, bytes))) return null;
    return unpackSegment(bytes);
  }

  /**
   * Hands versions to the gates, passing over those that wait on another until
   * nothing more goes in. How many were stored, and how many still wait.
   */
  async function take(versions: Version[]): Promise<{ added: number; waiting: number }> {
    let added = 0;
    let pending = versions;
    while (pending.length > 0) {
      const later: Version[] = [];
      for (const version of pending) {
        const taken = await config.accept(version);
        if (taken === 'later') later.push(version);
        if (taken === 'stored') {
          added += 1;
          await markKnownUnlessHeldWhole(version);
        }
      }
      if (later.length === pending.length) break;
      pending = later;
    }
    return { added, waiting: pending.length };
  }

  /** A stub of a version this store holds whole doesn't count: the whole one still goes out */
  async function markKnownUnlessHeldWhole(version: Version): Promise<void> {
    const held = isStub(version) ? await storage.getVersion(version.id) : null;
    if (!held || isStub(held)) await markKnown(version.id);
  }

  async function pullNow(): Promise<{ added: number }> {
    let added = 0;
    for (const key of await unreadSegments()) {
      const versions = await fetchSegment(key);
      if (!versions) continue;
      const taken = await take(versions);
      added += taken.added;
      if (taken.waiting === 0) await state.put(keys.read(key), MARK);
    }
    return { added };
  }

  // A store out of reach: the next change tries again, and nothing is lost meanwhile.
  const flushQuietly = () => serial(flushNow).catch(() => {});

  return Object.freeze({
    store,
    writer,
    pull: () => serial(pullNow),
    flush: () => serial(flushNow),
    compact: () => serial(compactNow),

    changed() {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void flushQuietly();
      }, flushMs);
      unref(timer);
    },

    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await flushQuietly();
    },
  });
}

async function readText(state: StorageAdapter, key: string): Promise<string | null> {
  const bytes = await state.get(key);
  return bytes ? utf8Decode(bytes) : null;
}

async function readOrCreate(state: StorageAdapter, key: string, create: () => string): Promise<string> {
  const existing = await readText(state, key);
  if (existing !== null) return existing;
  const value = create();
  await state.put(key, utf8Encode(value));
  return value;
}

/** Runs async work one at a time, in the order it was asked for */
function queue() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = last.then(work, work);
    last = next.catch(() => {});
    return next;
  };
}
