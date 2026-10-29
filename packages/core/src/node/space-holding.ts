/**
 * @module node/space-holding
 * Holding part of a space.
 *
 * With `cache` set, and once the space names a keeper, this node holds only
 * the collections it uses, besides the space's own. Sync takes in nothing
 * else. Its own writes are pending until enough keepers have them, and a
 * collection holding a pending write is never dropped. Without a keeper the
 * space is held whole: then this node may be one of its copies.
 */
import type { StorageAdapter, Version } from '../types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { AccessHistory } from '../space/roles.js';
import type { Holds, SyncEngine } from '../sync/sync-engine.js';
import { cidOfDigest } from '../utils/hash.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isObject, isRecord, isStringList, unref } from '../utils/guards.js';
import type { CacheConfig, NodeEvent } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Where it is kept in the space's store */
const CACHE_KEY = 'cache';
/** One entry per write of this node's still waiting for keepers: `pending/<id>` */
const PENDING_PREFIX = 'pending/';

interface CacheState {
  /**
   * Whether this node has caught up with a node holding the whole space at
   * least once: until then it can't know whether the space names keepers.
   */
  settled: boolean;
  /** Collection → when a query last used it: what this node holds */
  used: Record<string, number>;
  /** Collection → when it was first level with a node holding the whole space */
  level: Record<string, number>;
  /**
   * Collection → versions a writer's line there names as the one before, that
   * this node doesn't hold (02 §4.10). A collection is complete when it has
   * been level with a node holding everything and lacks nothing a line names.
   */
  missing: Record<string, string[]>;
}

/** A write waiting for keepers: its collection, and the keepers that have it */
interface Pending {
  readonly collection: string;
  readonly by: string[];
}

async function loadCacheState(adapter: StorageAdapter): Promise<CacheState> {
  try {
    const bytes = await adapter.get(CACHE_KEY);
    const parsed: unknown = bytes ? JSON.parse(utf8Decode(bytes)) : null;
    const saved = isRecord(parsed) ? parsed : {};
    return {
      settled: saved.settled === true,
      used: numbersIn(saved.used),
      level: numbersIn(saved.level),
      missing: listsIn(saved.missing),
    };
  } catch {
    return { settled: false, used: {}, level: {}, missing: {} };
  }
}

const numbersIn = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(isObject(value) ? value : {}).flatMap(([name, v]) =>
      typeof v === 'number' ? [[name, v]] : [],
    ),
  );

const listsIn = (value: unknown): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).flatMap(([name, ids]) =>
      Array.isArray(ids) ? [[name, ids.filter((id): id is string => typeof id === 'string')]] : [],
    ),
  );

const encodeJson = (value: unknown) => utf8Encode(JSON.stringify(value));

const isPending = (value: unknown): value is Pending =>
  isRecord(value) && typeof value.collection === 'string' && isStringList(value.by);

/** What holding part of the space reads of the open space */
export interface HoldingContext {
  readonly cache: CacheConfig | null;
  readonly adapter: StorageAdapter;
  readonly storage: StorageProvider;
  readonly spaceId: string;
  /** The key this node signs with: its writes are the ones that wait for keepers */
  readonly sessionDid: string;
  readonly emit: (event: NodeEvent) => void;
  readonly statusChanged: () => void;
  readonly isClosed: () => boolean;
  readonly access: () => Promise<{ readonly history: AccessHistory }>;
  /** Read when used: sync is made after what this node holds is known */
  readonly sync: () => SyncEngine;
  readonly connectedPeers: () => string[];
  readonly recordsChanged: () => void;
}

export async function openSpaceHolding(ctx: HoldingContext) {
  const {
    cache,
    adapter,
    storage,
    spaceId,
    sessionDid,
    emit,
    statusChanged,
    isClosed,
    access,
    sync,
    connectedPeers,
    recordsChanged,
  } = ctx;
  const cacheState = await loadCacheState(adapter);
  for (const collection of cache?.collections ?? [])
    if (!collection.startsWith('sys.')) cacheState.used[collection] ??= Date.now();
  // Only what it uses, until it has caught up enough to know whether the space names keepers.
  let partial = cache !== null;
  const holds = (): Holds => (partial ? new Set(Object.keys(cacheState.used)) : 'all');
  let dropTimer: ReturnType<typeof setInterval> | null = null;
  let tidying: Promise<void> = Promise.resolve();

  const declared = new Set((cache?.collections ?? []).filter((c) => !c.startsWith('sys.')));
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  const saveCache = () => {
    if (cacheTimer || !cache) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      void adapter.put(CACHE_KEY, encodeJson(cacheState)).catch(() => {});
    }, 500);
    unref(cacheTimer);
  };
  const flushCache = async () => {
    if (!cacheTimer) return;
    clearTimeout(cacheTimer);
    cacheTimer = null;
    await adapter.put(CACHE_KEY, encodeJson(cacheState)).catch(() => {});
  };
  /**
   * Holds part of the space from the moment it names a keeper, and all of it
   * again if it stops — once this node has caught up enough to know.
   */
  async function refreshHolds(): Promise<void> {
    if (!cache || isClosed()) return;
    const next = (await access()).history.current.keepers.length > 0 || !cacheState.settled;
    if (next === partial) return;
    partial = next;
    // Peers learn what this node holds now; anything newly held comes across.
    sync().notifyPeers(connectedPeers());
    statusChanged();
  }

  /** Collections a query or a screen uses: held from now on. Whether all of them are here yet. */
  function use(collections: ReadonlyArray<string>): boolean {
    if (!cache) return true;
    const now = Date.now();
    let added = false;
    for (const collection of collections) {
      if (typeof collection !== 'string' || collection.startsWith('sys.')) continue;
      const was = cacheState.used[collection];
      if (was === undefined) added = true;
      if (was === undefined || now - was > HOUR) {
        cacheState.used[collection] = now;
        saveCache();
      }
    }
    if (added && partial) sync().notifyPeers(connectedPeers());
    return !partial || collections.every((c) => c.startsWith('sys.') || completeHere(c));
  }

  /** Level with a node holding everything once, and lacking nothing a writer's line in it names */
  function completeHere(collection: string): boolean {
    return cacheState.level[collection] !== undefined && !(cacheState.missing[collection]?.length ?? 0);
  }

  /**
   * Keeps track of what each writer's line in a held collection names that
   * this node lacks: a version that names one not here adds it, and asks
   * every peer for it; one that arrives takes itself off.
   */
  async function noteGap(version: Version): Promise<void> {
    if (!cache || !version.log || version.collection.startsWith('sys.')) return;
    const { collection } = version;
    const missing = cacheState.missing[collection] ?? [];
    const before = version.log.prev;
    if (!before || missing.includes(before) || (await storage.getVersion(before))) return;
    cacheState.missing[collection] = [...missing, before];
    sync().ask(collection, [before]);
    saveCache();
    // A query that said "complete" says so no longer.
    if (partial) emit({ type: 'records', space: spaceId });
  }

  /**
   * Takes versions just stored off what was missing — only once they are in
   * the store, so a query never says "complete" for what it can't read yet.
   */
  function noteArrived(placed: ReadonlyArray<Version>): void {
    if (!cache) return;
    let changed = false;
    for (const version of placed) {
      const missing = cacheState.missing[version.collection];
      if (!missing?.includes(version.id)) continue;
      const left = missing.filter((id) => id !== version.id);
      if (left.length) cacheState.missing[version.collection] = left;
      else delete cacheState.missing[version.collection];
      changed = true;
    }
    if (changed) saveCache();
  }

  /** A write of this node's, waiting for keepers — only on a node that may hold part of a space */
  async function markPending(version: Version): Promise<void> {
    if (!cache || version.author !== sessionDid || version.collection.startsWith('sys.')) return;
    const pending: Pending = { collection: version.collection, by: [] };
    await adapter.put(`${PENDING_PREFIX}${version.id}`, encodeJson(pending));
  }

  /**
   * A keeper has some of this node's pending writes: those it named, or every
   * one in a collection it is level on. Once enough keepers have one, it
   * stops being pending. Only keepers the space names count.
   */
  async function confirm(
    peer: string,
    which: { ids?: ReadonlySet<string>; collection?: string },
  ): Promise<void> {
    if (!cache) return;
    const state = (await access()).history.current;
    if (!state.keepers.some((keeper) => keeper.did === peer)) return;
    const target = Math.min(state.keepers.length, Math.max(state.copies ?? 2, cache.copies ?? 0));
    for (const name of await adapter.list(PENDING_PREFIX)) {
      const id = name.slice(PENDING_PREFIX.length);
      if (which.ids && !which.ids.has(id)) continue;
      const bytes = await adapter.get(name);
      if (!bytes) continue;
      const pending: unknown = JSON.parse(utf8Decode(bytes));
      if (!isPending(pending)) continue;
      if (which.collection !== undefined && pending.collection !== which.collection) continue;
      if (!pending.by.includes(peer)) pending.by.push(peer);
      if (pending.by.length >= target) await adapter.delete(name);
      else await adapter.put(name, encodeJson(pending));
    }
  }

  /**
   * Drops collections no query has touched for a while: their records go,
   * and they are no longer held. Never one the app declared, nor one holding
   * a write still waiting for keepers.
   */
  async function dropUnused(): Promise<void> {
    if (!cache || !partial || isClosed()) return;
    const cutoff = Date.now() - (cache.unusedAfterDays ?? 30) * DAY;
    const waiting = new Set<string>();
    for (const name of await adapter.list(PENDING_PREFIX)) {
      const bytes = await adapter.get(name);
      const pending: unknown = bytes ? JSON.parse(utf8Decode(bytes)) : null;
      if (isPending(pending)) waiting.add(pending.collection);
    }
    let dropped = false;
    for (const [collection, at] of Object.entries(cacheState.used)) {
      if (at > cutoff || declared.has(collection) || waiting.has(collection)) continue;
      // No longer held first, so nothing syncs it back while it goes.
      delete cacheState.used[collection];
      delete cacheState.level[collection];
      delete cacheState.missing[collection];
      for (const item of (await storage.items(collection)).items)
        await storage.removeVersion(cidOfDigest(item.id));
      dropped = true;
    }
    if (!dropped) return;
    saveCache();
    recordsChanged();
    sync().notifyPeers(connectedPeers());
  }

  /** Starts holding: saves what was settled, follows sync, and drops what goes unused */
  function start(): void {
    saveCache();
    sync().on('synced', (_peer: string, full: boolean) => {
      if (!cache || !full || cacheState.settled) return;
      // Caught up with a node holding everything: the access history here is the space's now.
      cacheState.settled = true;
      saveCache();
      void refreshHolds().catch(() => {});
    });
    sync().on('stored', (peer: string, ids: ReadonlyArray<string>) => {
      void confirm(peer, { ids: new Set(ids) }).catch(() => {});
    });
    sync().on('level', (peer: string, collection: string, full: boolean) => {
      // What a line names and is not here yet: asked again, of whoever holds it now.
      const missing = cacheState.missing[collection];
      if (cache && missing?.length) sync().ask(collection, missing);
      if (cache && full && cacheState.level[collection] === undefined) {
        cacheState.level[collection] = Date.now();
        saveCache();
        // A query that said "not complete" says so no longer.
        if (partial) emit({ type: 'records', space: spaceId });
      }
      void confirm(peer, { collection }).catch(() => {});
    });
    // When the app opens the space, then every few hours while it stays open.
    dropTimer = cache ? setInterval(() => void dropUnused().catch(() => {}), 6 * HOUR) : null;
    tidying = cache ? dropUnused().catch(() => {}) : Promise.resolve();
    unref(dropTimer);
  }

  return Object.freeze({
    holds,
    refreshHolds,
    use,
    noteGap,
    noteArrived,
    markPending,
    start,
    /** What this node holds now, for its status */
    held: () => (partial ? Object.keys(cacheState.used).sort() : ('all' as const)),
    /** How many of this node's writes still wait for keepers */
    pending: async () => (await adapter.list(PENDING_PREFIX)).length,
    async close(): Promise<void> {
      if (dropTimer) clearInterval(dropTimer);
      await tidying;
      await flushCache();
    },
  });
}
