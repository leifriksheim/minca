/**
 * A space's store: record versions, and plain entries saying which is which.
 *
 * ```
 * r/<key>                      → the current version          (every record)
 * g/<key>                      → the record's first version   (once it has been edited)
 * h/<key>/<seq>/<id>           → a superseded version, whole  (only if marked `retain`)
 * i/<collection>/<time>/<id>   → every version kept, by collection — what sync compares
 * t/<collection>/<time>/<id>   → those in the shallow set — what a shallow exchange compares
 * ```
 *
 * A version that arrives is compared with the one at `r/<key>` by the ordering
 * rule (`records/version.ts`). The winner takes `r/<key>`; the loser is kept
 * as a stub, its envelope without its body, unless its writer marked it
 * `retain`. The same set of versions gives the same entries in any order of
 * arrival, which is what lets two peers converge.
 *
 * Sync compares the `i/` entries, one collection at a time
 * (`sync/negentropy.ts`). They are read once and kept in memory; another
 * writer's change reaches them through {@link StorageProvider.invalidate}.
 */

import type { StorageAdapter, Version, BatchOp } from '../types.js';
import { byVersion, supersedes } from '../records/version.js';
import { isStub, stubOf } from '../schema/version.js';
import { utf8Encode, utf8Decode, bytesToHex } from '../utils/encoding.js';
import { cidDigest } from '../utils/hash.js';
import { getOrAdd } from '../utils/map.js';
import { queue } from '../utils/serial.js';
import { createBodyCache, type BodyCache } from './body-cache.js';
import {
  addToSum,
  combineSums,
  EMPTY_SUM,
  fingerprintOf,
  ItemSet,
  removeFromSum,
  type Item,
  type Sum,
} from '../sync/negentropy.js';

export interface StorageProvider {
  /**
   * Takes in a version of a record: it becomes current if it supersedes the
   * current one, and is kept or dropped otherwise. Idempotent.
   */
  addVersion(version: Version): Promise<void>;
  /** Drops a version from the store and wherever it is indexed. */
  removeVersion(id: string): Promise<void>;
  /** A version by its id, current or not, if this store holds it. */
  getVersion(id: string): Promise<Version | null>;
  /** The current version of a record — possibly a delete. */
  getCurrent(key: string): Promise<Version | null>;
  /** The record's first version, when it has been edited and so is stored apart. */
  getGenesis(key: string): Promise<Version | null>;
  /** Every version of a record this store keeps: current, first, and retained. Newest first. */
  history(key: string): Promise<Version[]>;
  /** {@link history} for every record whose key starts with `prefix`, reading only those entries. */
  histories(prefix: string): Promise<Map<string, Version[]>>;
  /** Current versions of every record, deletes included. */
  listCurrent(): Promise<Version[]>;
  /** Current versions in one collection, deletes included — found through the store's collection index. */
  queryVersions(collection: string): Promise<Version[]>;
  /** The id of every version this store keeps — current, first and retained. */
  versionIds(): Promise<string[]>;
  /** Every version kept in one collection, current or not, superseded ones as their stubs. */
  keptVersions(collection: string): Promise<Version[]>;
  /** The versions kept in one collection, as sync compares them: sorted, with sums. */
  items(collection: string): Promise<ItemSet>;
  /** Every collection this store keeps anything in, and the sum of its version ids. */
  sums(): Promise<ReadonlyMap<string, Sum>>;
  /** {@link items} of a collection's shallow set ({@link inShallowSet}), as a shallow exchange compares it (05 §5). */
  shallowItems(collection: string): Promise<ItemSet>;
  /** {@link sums} of every collection's shallow set. */
  shallowSums(): Promise<ReadonlyMap<string, Sum>>;
  /**
   * One fingerprint of everything kept, hex. Equal fingerprints mean the
   * same versions kept — for status, and for tests.
   */
  fingerprint(): Promise<string>;
  /** Forgets what was read into memory: another writer changed the store underneath. */
  invalidate(): void;
  /** Close the storage adapter. */
  close(): Promise<void>;
}

export const CURRENT_PREFIX = 'r/';
export const GENESIS_PREFIX = 'g/';
export const HISTORY_PREFIX = 'h/';
export const ITEM_PREFIX = 'i/';
/** `t/<collection>/<time>/<id>`: the versions of {@link ITEM_PREFIX} in their collection's shallow set */
export const SHALLOW_PREFIX = 't/';
/** Present once a store's `t/` entries are complete: one kept before them is indexed once, when first read */
const SHALLOW_INDEXED = 'shallow-indexed';
/** Versions read at a time while indexing a store kept before `t/`, between which other work runs */
const INDEX_CHUNK = 200;
/** Version bodies a store keeps in memory when it has a cache of its own, the one used longest ago let go first */
const MAX_BODIES = 50_000;

const currentKey = (key: string) => `${CURRENT_PREFIX}${key}`;
const genesisKey = (key: string) => `${GENESIS_PREFIX}${key}`;
/** `seq` padded so a key's history lists in order */
const historyKey = (e: Version) => `${HISTORY_PREFIX}${e.key}/${String(e.seq).padStart(15, '0')}/${e.id}`;

/**
 * Where a version sorts for sync: its own time, in whole seconds. Only an
 * order — a wrong clock makes a version slower to find, never lost.
 */
export function syncTime(version: Pick<Version, 'createdAt'>): number {
  const ms = Date.parse(version.createdAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

/** Collection names may hold anything; the entry needs them free of `/`. */
const itemKey = (e: Version, prefix = ITEM_PREFIX) =>
  `${prefix}${encodeURIComponent(e.collection)}/${syncTime(e)}/${e.id}`;

/**
 * Whether a kept version is in its collection's shallow set (05 §5): every
 * version but an unretained stub past a record's first. Decided by the
 * version alone, so two stores keeping the same versions keep the same set.
 */
export const inShallowSet = (version: Version): boolean =>
  !isStub(version) || version.seq === 0 || version.retain === true;

/** Reads an `i/` or `t/` entry back: null for anything malformed, or an id that is not a content id */
function parseItemKey(key: string): { collection: string; id: string; item: Item } | null {
  const [, collection, time, id, extra] = key.split('/');
  if (collection === undefined || time === undefined || id === undefined || extra !== undefined) return null;
  const digest = cidDigest(id);
  const timestamp = Number(time);
  if (!digest || !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  try {
    return { collection: decodeURIComponent(collection), id, item: { timestamp, id: digest } };
  } catch {
    return null;
  }
}

/** What one change reads and writes, held until it lands */
interface Entries {
  get(key: string): Promise<string | null>;
  set(key: string, id: string): void;
  unset(key: string): void;
  /** Stores a version, whole or a stub, and indexes it for sync */
  keep(version: Version): Promise<void>;
  /** Unindexes a version; its body is deleted once the change has landed */
  drop(version: Version): void;
}

/** What a change, or a group of them, writes: entries, versions indexed and unindexed, bodies not held yet */
interface Batch {
  readonly writes: Map<string, Uint8Array | null>;
  readonly added: Map<string, Version>;
  readonly dropped: Map<string, Version>;
  readonly toStore: Map<string, Version>;
}

const emptyBatch = (): Batch => ({
  writes: new Map(),
  added: new Map(),
  dropped: new Map(),
  toStore: new Map(),
});

/** Adds one change's batch to its group's */
function mergeInto(group: Batch, layer: Batch): void {
  for (const [key, value] of layer.writes) group.writes.set(key, value);
  for (const [id, version] of layer.added) {
    group.added.set(id, version);
    group.dropped.delete(id);
  }
  for (const [id, version] of layer.dropped) {
    group.dropped.set(id, version);
    group.added.delete(id);
    group.toStore.delete(id);
  }
  for (const [id, version] of layer.toStore) group.toStore.set(id, version);
}

const decodeId = (bytes: Uint8Array | null | undefined) => (bytes ? utf8Decode(bytes) : null);

/** Every `i/` entry (or `t/`), by collection, then by id */
async function readKept(
  adapter: StorageAdapter,
  prefix = ITEM_PREFIX,
): Promise<Map<string, Map<string, Item>>> {
  const kept = new Map<string, Map<string, Item>>();
  for (const key of await adapter.list(prefix)) {
    const parsed = parseItemKey(key);
    if (parsed) getOrAdd(kept, parsed.collection, () => new Map()).set(parsed.id, parsed.item);
  }
  return kept;
}

function sumOf(items: Iterable<Item>): Sum {
  let sum = EMPTY_SUM;
  for (const item of items) sum = addToSum(sum, item.id);
  return sum;
}

/** Versions kept, by collection then id, with each collection's sum kept up to date: what sync compares */
interface Index {
  readonly byCollection: Map<string, Map<string, Item>>;
  readonly totals: Map<string, Sum>;
}

const indexOf = (byCollection: Map<string, Map<string, Item>>): Index => ({
  byCollection,
  totals: new Map([...byCollection].map(([collection, byId]) => [collection, sumOf(byId.values())])),
});

function addToIndex(index: Index, e: Version): void {
  const digest = cidDigest(e.id);
  const byId = getOrAdd(index.byCollection, e.collection, () => new Map<string, Item>());
  if (!digest || byId.has(e.id)) return;
  byId.set(e.id, { timestamp: syncTime(e), id: digest });
  index.totals.set(e.collection, addToSum(index.totals.get(e.collection) ?? EMPTY_SUM, digest));
}

function removeFromIndex(index: Index, e: Version): void {
  const item = index.byCollection.get(e.collection)?.get(e.id);
  if (!item) return;
  index.byCollection.get(e.collection)!.delete(e.id);
  index.totals.set(e.collection, removeFromSum(index.totals.get(e.collection) ?? EMPTY_SUM, item.id));
}

const yieldToOthers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Creates a StorageProvider wrapping an adapter.
 * @param cache Where it keeps version bodies in memory: shared with other
 *   stores, or by default one of its own of 50,000
 */
export function createStorageProvider(adapter: StorageAdapter, cache?: BodyCache): StorageProvider {
  // A change reads the current version, then writes: two interleaved would
  // decide against the same one. So changes take turns.
  const exclusively = queue();

  // ─── What is read often, in memory ─────────────────────────────────
  //
  // Which version is current or first for a record, and version bodies. This
  // store is the only writer of its adapter until `invalidate` says
  // otherwise, so what it read or wrote stays true. A body never changes
  // under its id; a pointer read while a change was landing is not kept.

  /** `r/` and `g/` entries: the id they name, or null for none */
  const pointers = new Map<string, string | null>();
  /** Version bodies by id, the one used longest ago let go first */
  const bodies = (cache ?? createBodyCache(MAX_BODIES)).part();
  /** Counts changes landed, so a read that raced one is not kept */
  let landed = 0;

  const isPointer = (key: string) => key.startsWith(CURRENT_PREFIX) || key.startsWith(GENESIS_PREFIX);

  const remember = (version: Version) => bodies.set(version);

  /** Bodies the changes landing now will store: readable by the changes after them in the same group */
  const staging = new Map<string, Version>();

  async function body(id: string): Promise<Version | null> {
    const known = staging.get(id) ?? bodies.get(id);
    if (known) return known;
    const version = await adapter.getVersion(id);
    if (version) remember(version);
    return version;
  }

  // ─── What sync compares, in memory ─────────────────────────────────

  /** Every version kept, and the shallow sets' (`i/` and `t/`). Null until first needed. */
  let indexes: { readonly all: Index; readonly shallow: Index } | null = null;
  /** Sorted sets, built when a reconciliation asks for one and dropped when their collection changes */
  const sets = new Map<string, ItemSet>();
  const shallowSets = new Map<string, ItemSet>();

  /** Read in turn with changes, so none lands between the listing and the sets being kept up to date */
  const loadIndexes = async (): Promise<{ readonly all: Index; readonly shallow: Index }> =>
    indexes ??
    exclusively(async () => {
      if (indexes) return indexes;
      const all = await readKept(adapter);
      const shallow = (await adapter.get(SHALLOW_INDEXED))
        ? await readKept(adapter, SHALLOW_PREFIX)
        : await indexShallow(all);
      indexes = { all: indexOf(all), shallow: indexOf(shallow) };
      return indexes;
    });
  const loadKept = async () => (await loadIndexes()).all.byCollection;

  /**
   * Writes the `t/` entries of a store kept before them, reading each version
   * once, a chunk at a time so a large store doesn't hold up everything else.
   * Run in turn with changes, so none lands meanwhile.
   */
  async function indexShallow(all: Map<string, Map<string, Item>>): Promise<Map<string, Map<string, Item>>> {
    const shallow = new Map<string, Map<string, Item>>();
    for (const [collection, byId] of all) {
      const ids = [...byId.keys()];
      for (let from = 0; from < ids.length; from += INDEX_CHUNK) {
        const ops: BatchOp[] = [];
        for (const version of await load(ids.slice(from, from + INDEX_CHUNK))) {
          if (!inShallowSet(version)) continue;
          ops.push({ type: 'put', key: itemKey(version, SHALLOW_PREFIX), value: utf8Encode(version.id) });
          getOrAdd(shallow, collection, () => new Map<string, Item>()).set(version.id, byId.get(version.id)!);
        }
        if (ops.length > 0) await adapter.batch(ops);
        await yieldToOthers();
      }
    }
    await adapter.put(SHALLOW_INDEXED, utf8Encode('1'));
    return shallow;
  }

  /** Keeps the in-memory sets in step with a change just written */
  const track = (added: ReadonlyArray<Version>, removed: ReadonlyArray<Version>) => {
    for (const e of [...added, ...removed]) {
      sets.delete(e.collection);
      shallowSets.delete(e.collection);
    }
    if (!indexes) return;
    for (const e of removed) {
      removeFromIndex(indexes.all, e);
      removeFromIndex(indexes.shallow, e);
    }
    for (const e of added) {
      addToIndex(indexes.all, e);
      // Kept again as its stub once superseded: out of the shallow set, unless it is a first version or retained.
      if (inShallowSet(e)) addToIndex(indexes.shallow, e);
      else removeFromIndex(indexes.shallow, e);
    }
  };

  // ─── Changes ───────────────────────────────────────────────────────

  /** A change waiting to land */
  interface Pending {
    readonly run: (entries: Entries) => Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }
  /** Changes that came in while others were landing: the next group */
  let pending: Pending[] = [];
  let landing = false;

  /**
   * Runs one change. Changes run one at a time, each seeing the ones before
   * it; those that came in while others were landing land together, in one
   * write where the adapter can. A change lands whole or not at all.
   */
  const change = (run: (entries: Entries) => Promise<void>): Promise<void> =>
    new Promise((resolve, reject) => {
      pending.push({ run, resolve, reject });
      if (!landing) landNext();
    });

  function landNext(): void {
    landing = true;
    void exclusively(() => {
      const group = pending;
      pending = [];
      return land(group);
    }).finally(() => {
      landing = false;
      if (pending.length > 0) landNext();
    });
  }

  async function land(group: ReadonlyArray<Pending>): Promise<void> {
    const batch = emptyBatch();
    const ran: Pending[] = [];
    for (const one of group) {
      // Each change on a layer of its own, so one that fails leaves nothing behind.
      const layer = emptyBatch();
      try {
        await one.run(entriesOn(layer, batch));
      } catch (error) {
        for (const id of layer.toStore.keys()) if (!batch.toStore.has(id)) staging.delete(id);
        one.reject(error);
        continue;
      }
      mergeInto(batch, layer);
      ran.push(one);
    }

    if (batch.writes.size === 0 && batch.dropped.size === 0) {
      staging.clear();
      for (const one of ran) one.resolve();
      return;
    }
    landed++;
    try {
      await write(batch);
    } catch (error) {
      // Whether any of it landed is unknown: read it all again.
      pointers.clear();
      bodies.clear();
      staging.clear();
      for (const one of ran) one.reject(error);
      return;
    } finally {
      // Also after: a read that started while this was landing may have seen either side of it.
      landed++;
    }
    staging.clear();
    for (const version of batch.toStore.values()) remember(version);
    for (const [key, value] of batch.writes) if (isPointer(key)) pointers.set(key, decodeId(value));
    for (const id of batch.dropped.keys()) bodies.delete(id);
    track([...batch.added.values()], [...batch.dropped.values()]);
    for (const one of ran) one.resolve();
  }

  /** What a change reads and writes: its own layer, over what its group wrote before it */
  function entriesOn(layer: Batch, group: Batch): Entries {
    return {
      get: async (key) => {
        const source = [layer.writes, group.writes].find((writes) => writes.has(key));
        return source ? decodeId(source.get(key)) : readId(key);
      },
      set: (key, id) => void layer.writes.set(key, utf8Encode(id)),
      unset: (key) => void layer.writes.set(key, null),
      keep: async (version) => {
        // A copy already held as this — a current version kept whole — is not written again.
        const held = bodies.get(version.id);
        if (!held || isStub(held) !== isStub(version)) {
          layer.toStore.set(version.id, version);
          staging.set(version.id, version);
        }
        layer.writes.set(itemKey(version), utf8Encode(version.id));
        layer.writes.set(
          itemKey(version, SHALLOW_PREFIX),
          inShallowSet(version) ? utf8Encode(version.id) : null,
        );
        layer.added.set(version.id, version);
        layer.dropped.delete(version.id);
      },
      drop: (version) => {
        layer.writes.set(itemKey(version), null);
        layer.writes.set(itemKey(version, SHALLOW_PREFIX), null);
        layer.dropped.set(version.id, version);
        layer.added.delete(version.id);
        layer.toStore.delete(version.id);
      },
    };
  }

  /** Writes a group's batch, in one commit where the adapter can */
  async function write({ writes, toStore, dropped }: Batch): Promise<void> {
    const ops = [...writes].map(([key, value]): BatchOp =>
      value ? { type: 'put', key, value } : { type: 'delete', key },
    );
    if (adapter.commit) {
      return adapter.commit({ store: [...toStore.values()], ops, remove: [...dropped.keys()] });
    }
    // Bodies first and deletes last, so no entry ever names a version that is not there.
    for (const version of toStore.values()) await adapter.putVersion(version);
    await adapter.batch(ops);
    for (const id of dropped.keys()) await adapter.deleteVersion(id);
  }

  /**
   * Places a version that is not current: kept whole if retained, as a stub
   * otherwise, and kept apart as a first version if it is the lowest-id one
   * seen.
   */
  async function demote(entries: Entries, version: Version, current: Version): Promise<void> {
    await keepSuperseded(entries, version);
    // A first version is kept apart, so a record's history lists it: the
    // lowest id if there are several. Nothing reads who created a record from
    // it; that is the first version a version's own chain names (02 §4.5).
    // Not while the record is still at seq 0: then the current version is it.
    if (version.seq === 0 && current.seq > 0) {
      const heldId = await entries.get(genesisKey(version.key));
      if (heldId === null || version.id < heldId) entries.set(genesisKey(version.key), version.id);
    }
  }

  /** Keeps a superseded version: whole if its writer said to retain it, else as a stub */
  async function keepSuperseded(entries: Entries, version: Version): Promise<void> {
    if (!version.retain) return entries.keep(stubOf(version));
    // A stub of a retained version is kept only until the whole of it turns up.
    const held = isStub(version) ? await body(version.id) : null;
    await entries.keep(held && !isStub(held) ? held : version);
    entries.set(historyKey(version), version.id);
  }

  /**
   * Versions by id, those held, in one read where the adapter can. What it
   * read is returned, not read back from the cache, which may hold fewer.
   */
  async function load(ids: Iterable<string>): Promise<Version[]> {
    const wanted = [...ids];
    const found = new Map<string, Version>();
    const missing: string[] = [];
    for (const id of wanted) {
      const held = bodies.get(id);
      if (held) found.set(id, held);
      else missing.push(id);
    }
    if (adapter.getVersions && missing.length > 1) {
      for (const version of await adapter.getVersions(missing)) {
        if (!version) continue;
        found.set(version.id, version);
        remember(version);
      }
    } else {
      for (const version of await Promise.all(missing.map((id) => body(id))))
        if (version) found.set(version.id, version);
    }
    return wanted.flatMap((id) => found.get(id) ?? []);
  }

  /** `[entry key, version id]` for every pointer under a prefix, in one read where the adapter can */
  async function pointersUnder(prefix: string): Promise<Array<readonly [string, string]>> {
    if (!adapter.entries) {
      const found = await Promise.all(
        (await adapter.list(prefix)).map(async (key) => [key, await readId(key)] as const),
      );
      return found.filter((entry): entry is readonly [string, string] => entry[1] !== null);
    }
    const before = landed;
    const found = (await adapter.entries(prefix)).map(([key, bytes]) => [key, utf8Decode(bytes)] as const);
    if (before === landed) for (const [key, id] of found) pointers.set(key, id);
    return found;
  }

  const readId = async (key: string): Promise<string | null> => {
    const pointer = isPointer(key);
    if (pointer && pointers.has(key)) return pointers.get(key)!;
    const before = landed;
    const id = decodeId(await adapter.get(key));
    if (pointer && before === landed) pointers.set(key, id);
    return id;
  };

  async function histories(prefix: string): Promise<Map<string, Version[]>> {
    const ids = new Map<string, Set<string>>();
    const add = (key: string, id: string) => getOrAdd(ids, key, () => new Set<string>()).add(id);
    for (const entry of [CURRENT_PREFIX, GENESIS_PREFIX]) {
      for (const [name, id] of await pointersUnder(`${entry}${prefix}`)) add(name.slice(entry.length), id);
    }
    // `h/<key>/<seq>/<id>` — a record key holds no `/`, and the id is in the entry's name.
    for (const name of await adapter.list(`${HISTORY_PREFIX}${prefix}`)) {
      const [, key, , id] = name.split('/');
      if (key && id) add(key, id);
    }
    const allIds = new Set([...ids.values()].flatMap((held) => [...held]));
    const found = new Map((await load(allIds)).map((version) => [version.id, version]));
    const versionsOf = (held: Set<string>) => [...held].flatMap((id) => found.get(id) ?? []).sort(byVersion);
    return new Map([...ids].map(([key, held]) => [key, versionsOf(held)]));
  }

  async function itemsOf(collection: string, shallow: boolean): Promise<ItemSet> {
    const cache = shallow ? shallowSets : sets;
    const cached = cache.get(collection);
    if (cached) return cached;
    const index = (await loadIndexes())[shallow ? 'shallow' : 'all'];
    const set = new ItemSet(index.byCollection.get(collection)?.values() ?? []);
    cache.set(collection, set);
    return set;
  }

  async function sumsOf(shallow: boolean): Promise<Map<string, Sum>> {
    const index = (await loadIndexes())[shallow ? 'shallow' : 'all'];
    return new Map([...index.totals].filter(([, sum]) => sum.count > 0));
  }

  const items = (collection: string) => itemsOf(collection, false);
  const sums = () => sumsOf(false);

  return Object.freeze({
    addVersion(incoming: Version): Promise<void> {
      return change(async (entries) => {
        const currentId = await entries.get(currentKey(incoming.key));
        const current = currentId ? await body(currentId) : null;
        if (currentId === incoming.id) {
          // The body of a current version held only as a stub: take it.
          if (current && isStub(current) && !isStub(incoming)) await entries.keep(incoming);
          return;
        }
        if (current && !supersedes(incoming, current)) return demote(entries, incoming, current);

        await entries.keep(incoming);
        entries.set(currentKey(incoming.key), incoming.id);
        if (current) await demote(entries, current, incoming);
      });
    },

    removeVersion(id: string): Promise<void> {
      return change(async (entries) => {
        const version = await body(id);
        if (!version) return;
        for (const key of [currentKey(version.key), genesisKey(version.key)]) {
          if ((await entries.get(key)) === id) entries.unset(key);
        }
        entries.unset(historyKey(version));
        entries.drop(version);
      });
    },

    getVersion: body,

    async getCurrent(key: string): Promise<Version | null> {
      const id = await readId(currentKey(key));
      return id ? body(id) : null;
    },

    async getGenesis(key: string): Promise<Version | null> {
      const id = await readId(genesisKey(key));
      return id ? body(id) : null;
    },

    async history(key: string): Promise<Version[]> {
      return (await histories(key)).get(key) ?? [];
    },

    histories,

    async listCurrent(): Promise<Version[]> {
      return load((await pointersUnder(CURRENT_PREFIX)).map(([, id]) => id));
    },

    async queryVersions(collection: string): Promise<Version[]> {
      // `i/` names every version kept, not only current ones; the entries say which is current.
      const held = await load((await loadKept()).get(collection)?.keys() ?? []);
      const current = await Promise.all(held.map(async (v) => (await readId(currentKey(v.key))) === v.id));
      return held.filter((_, i) => current[i]);
    },

    async keptVersions(collection: string): Promise<Version[]> {
      return load((await loadKept()).get(collection)?.keys() ?? []);
    },

    async versionIds(): Promise<string[]> {
      return [...(await loadKept()).values()].flatMap((byId) => [...byId.keys()]);
    },

    items,
    sums,
    shallowItems: (collection: string) => itemsOf(collection, true),
    shallowSums: () => sumsOf(true),

    async fingerprint(): Promise<string> {
      let total = EMPTY_SUM;
      for (const sum of (await sums()).values()) total = combineSums(total, sum);
      return bytesToHex(await fingerprintOf(total));
    },

    invalidate() {
      indexes = null;
      sets.clear();
      shallowSets.clear();
      pointers.clear();
      bodies.clear();
      landed++;
    },

    async close(): Promise<void> {
      await adapter.close();
    },
  });
}
