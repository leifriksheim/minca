/**
 * A space's store: record versions, and plain entries saying which is which.
 *
 * ```
 * r/<key>                      → the current version          (every record)
 * g/<key>                      → the record's first version   (once it has been edited)
 * h/<key>/<seq>/<id>           → a superseded version, whole  (only if marked `retain`)
 * i/<collection>/<time>/<id>   → every version kept, by collection — what sync compares
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
/** Version bodies a store keeps in memory, the oldest let go first */
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
const itemKey = (e: Version) => `${ITEM_PREFIX}${encodeURIComponent(e.collection)}/${syncTime(e)}/${e.id}`;

/** Reads an `i/` entry back: null for anything malformed, or an id that is not a content id */
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

/** Every `i/` entry, by collection, then by id */
async function readKept(adapter: StorageAdapter): Promise<Map<string, Map<string, Item>>> {
  const kept = new Map<string, Map<string, Item>>();
  for (const key of await adapter.list(ITEM_PREFIX)) {
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

/** Creates a StorageProvider wrapping an adapter. */
export function createStorageProvider(adapter: StorageAdapter): StorageProvider {
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
  /** Version bodies by id, the oldest let go first */
  const bodies = new Map<string, Version>();
  /** Counts changes landed, so a read that raced one is not kept */
  let landed = 0;

  const isPointer = (key: string) => key.startsWith(CURRENT_PREFIX) || key.startsWith(GENESIS_PREFIX);

  const remember = (version: Version) => {
    bodies.delete(version.id);
    bodies.set(version.id, version);
    if (bodies.size > MAX_BODIES) bodies.delete(bodies.keys().next().value!);
  };

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

  /** Versions kept, by collection, then by id. Null until first needed. */
  let kept: Map<string, Map<string, Item>> | null = null;
  /** Sorted sets, built when a reconciliation asks for one and dropped when their collection changes */
  const sets = new Map<string, ItemSet>();
  /** The sum of each collection's ids, kept up to date on every change: a hello needs no sorting */
  let totals: Map<string, Sum> | null = null;

  /** Read in turn with changes, so none lands between the listing and the sets being kept up to date */
  const loadKept = async (): Promise<Map<string, Map<string, Item>>> =>
    kept ??
    exclusively(async () => {
      if (kept) return kept;
      const loaded = await readKept(adapter);
      kept = loaded;
      totals = new Map([...loaded].map(([collection, byId]) => [collection, sumOf(byId.values())]));
      return loaded;
    });

  /** Keeps the in-memory sets in step with a change just written */
  const track = (added: ReadonlyArray<Version>, removed: ReadonlyArray<Version>) => {
    for (const e of [...added, ...removed]) sets.delete(e.collection);
    if (!kept || !totals) return;
    for (const e of removed) {
      const item = kept.get(e.collection)?.get(e.id);
      if (!item) continue;
      kept.get(e.collection)!.delete(e.id);
      totals.set(e.collection, removeFromSum(totals.get(e.collection) ?? EMPTY_SUM, item.id));
    }
    for (const e of added) {
      const digest = cidDigest(e.id);
      const byId = getOrAdd(kept, e.collection, () => new Map<string, Item>());
      if (!digest || byId.has(e.id)) continue;
      byId.set(e.id, { timestamp: syncTime(e), id: digest });
      totals.set(e.collection, addToSum(totals.get(e.collection) ?? EMPTY_SUM, digest));
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
        layer.added.set(version.id, version);
        layer.dropped.delete(version.id);
      },
      drop: (version) => {
        layer.writes.set(itemKey(version), null);
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

  /** Versions by id, those held, in one read where the adapter can */
  async function load(ids: Iterable<string>): Promise<Version[]> {
    const wanted = [...ids];
    const missing = wanted.filter((id) => !bodies.has(id));
    if (adapter.getVersions && missing.length > 1) {
      for (const version of await adapter.getVersions(missing)) if (version) remember(version);
    } else {
      await Promise.all(missing.map((id) => body(id)));
    }
    return wanted.map((id) => bodies.get(id)).filter((v): v is Version => v !== undefined);
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

  async function items(collection: string): Promise<ItemSet> {
    const cached = sets.get(collection);
    if (cached) return cached;
    const set = new ItemSet((await loadKept()).get(collection)?.values() ?? []);
    sets.set(collection, set);
    return set;
  }

  async function sums(): Promise<Map<string, Sum>> {
    await loadKept();
    return new Map([...(totals ?? [])].filter(([, sum]) => sum.count > 0));
  }

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

    async fingerprint(): Promise<string> {
      let total = EMPTY_SUM;
      for (const sum of (await sums()).values()) total = combineSums(total, sum);
      return bytesToHex(await fingerprintOf(total));
    },

    invalidate() {
      kept = null;
      totals = null;
      sets.clear();
      pointers.clear();
      bodies.clear();
      landed++;
    },

    async close(): Promise<void> {
      await adapter.close();
    },
  });
}
