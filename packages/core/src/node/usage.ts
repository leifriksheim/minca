/**
 * @module node/usage
 * How much each space a host carries is used: how many accounts wrote there
 * and how many devices read, over a rolling window (spec 08 §1.1).
 *
 * One set per space per UTC day. Writers are kept on disk, as salted hashes
 * so the meter names nobody, and a restart doesn't count anyone twice.
 * Readers stay in memory: they only hint, and forgetting some counts fewer.
 * Not mirrored: a lost disk counts from nothing again.
 */
import { queue } from '../utils/serial.js';
import type { StorageAdapter } from '../types.js';
import { bytesToHex, concatBytes, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';

const DAY = 86_400;
const PREFIX = 'usage:';
const SALT_KEY = 'usage-salt';
const FIRST_PREFIX = 'first:';
/** Readers kept for one space over the whole window: past it the count stops growing, so made-up keys cost no more */
const MAX_READERS_A_SPACE = 10_000;
/** Readers kept for every space together, however many spaces someone makes to read */
const MAX_READERS = 1_000_000;
/** Writers kept for one space on one day: far past any free line, so filling it costs whoever does it as much as the host */
const MAX_WRITERS_A_DAY = 50_000;

export interface UsageMeterConfig {
  readonly store: StorageAdapter;
  readonly windowDays: number;
  /** Unix seconds now; for tests */
  readonly now?: () => number;
}

/** What the meter counted for a space over its window */
interface Counted {
  readonly writers: number;
  readonly readers: number;
  readonly windowDays: number;
}

/** Entries by space, then by UTC day */
type Days = Map<string, Set<string>>;
type BySpace = Map<string, Days>;

/** Opens the meter, reading back what it counted before a restart */
export async function createUsageMeter(config: UsageMeterConfig) {
  const { store } = config;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const salt = await readOrCreateSalt(store);
  /** When the meter first saw each space, unix seconds */
  const first = await loadFirstSeen(store);
  /** Salted hashes of accounts, kept on disk */
  const writers = await loadWriters(store);
  /** Session DIDs, in memory only */
  const readers: BySpace = new Map();
  /** How many reader entries are kept, across every space and day */
  let kept = 0;
  /** Each space's members, hashed, as last asked: hashed again only when they change */
  const memberHashes = new Map<string, { readonly members: string; readonly hashes: ReadonlySet<string> }>();

  const hashOf = async (spaceId: string, account: string) =>
    bytesToHex((await sha256(concatBytes(salt, utf8Encode(`${spaceId}\n${account}`)))).slice(0, 16));

  async function hashesOf(spaceId: string, members: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    const joined = members.join('\n');
    const known = memberHashes.get(spaceId);
    if (known?.members === joined) return known.hashes;
    const hashes = new Set(await Promise.all(members.map((member) => hashOf(spaceId, member))));
    memberHashes.set(spaceId, { members: joined, hashes });
    return hashes;
  }

  /** The days still inside the window, today included */
  const window = (): ReadonlySet<string> => {
    const today = now();
    return new Set(Array.from({ length: config.windowDays }, (_, back) => dayOf(today - back * DAY)));
  };

  // Writes go one after another, so a later one never loses to an earlier.
  const later = queue();

  // A day's set is written whole, once for however many writers joined it while the last write ran.
  const dirty = new Set<string>();
  let flushing: Promise<void> | null = null;
  const persist = (spaceId: string, day: string): Promise<void> => {
    dirty.add(`${spaceId}:${day}`);
    flushing ??= later(async () => {
      for (const key of dirty) {
        dirty.delete(key);
        const [spaceId, day] = splitDayKey(key);
        const set = writers.get(spaceId)?.get(day);
        if (set) await store.put(`${PREFIX}${key}`, utf8Encode(JSON.stringify([...set])));
      }
      flushing = null;
    });
    return flushing;
  };

  const deleteWriterDay = (spaceId: string, day: string) =>
    later(() => store.delete(`${PREFIX}${spaceId}:${day}`));

  return Object.freeze({
    /** An account wrote in a space: counted once a day, whatever it wrote */
    async wrote(spaceId: string, account: string): Promise<void> {
      const day = dayOf(now());
      const hash = await hashOf(spaceId, account);
      const set = setFor(writers, spaceId, day);
      if (set.has(hash) || set.size >= MAX_WRITERS_A_DAY) return;
      set.add(hash);
      await persist(spaceId, day);
    },

    /** A session key proved it may read a space */
    read(spaceId: string, session: string): void {
      if (kept >= MAX_READERS || sizeOf(readers.get(spaceId)) >= MAX_READERS_A_SPACE) return;
      const set = setFor(readers, spaceId, dayOf(now()));
      if (set.has(session)) return;
      set.add(session);
      kept += 1;
    },

    /** When the meter first saw a space, kept from now if it never did: what arrives soon after is history */
    async firstSeen(spaceId: string): Promise<number> {
      const known = first.get(spaceId);
      if (known !== undefined) return known;
      const at = now();
      first.set(spaceId, at);
      await later(() => store.put(`${FIRST_PREFIX}${spaceId}`, utf8Encode(String(at))));
      return at;
    },

    /** How a space was used over the window; with `members`, only the writers among them count */
    async usage(spaceId: string, members?: ReadonlyArray<string>): Promise<Counted> {
      const within = window();
      const only = members ? await hashesOf(spaceId, members) : undefined;
      return {
        writers: distinct(writers.get(spaceId), within, only),
        readers: distinct(readers.get(spaceId), within),
        windowDays: config.windowDays,
      };
    },

    /** Drops every day past the window */
    async prune(): Promise<void> {
      const within = window();
      for (const [spaceId, days] of writers)
        for (const day of [...days.keys()]) {
          if (within.has(day)) continue;
          days.delete(day);
          await deleteWriterDay(spaceId, day);
        }
      for (const days of readers.values())
        for (const [day, set] of days) {
          if (within.has(day)) continue;
          kept -= set.size;
          days.delete(day);
        }
      dropEmpty(writers);
      dropEmpty(readers);
    },

    /** Forgets a space altogether */
    async forget(spaceId: string): Promise<void> {
      for (const day of writers.get(spaceId)?.keys() ?? []) await deleteWriterDay(spaceId, day);
      writers.delete(spaceId);
      kept -= sizeOf(readers.get(spaceId));
      readers.delete(spaceId);
      memberHashes.delete(spaceId);
      if (first.delete(spaceId)) await later(() => store.delete(`${FIRST_PREFIX}${spaceId}`));
    },

    /** Waits for what is being written */
    flushed: () => later(async () => {}),
  });
}

async function readOrCreateSalt(store: StorageAdapter): Promise<Uint8Array> {
  const existing = await store.get(SALT_KEY);
  if (existing) return existing;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
  await store.put(SALT_KEY, salt);
  return salt;
}

async function loadFirstSeen(store: StorageAdapter): Promise<Map<string, number>> {
  const first = new Map<string, number>();
  for (const key of await store.list(FIRST_PREFIX)) {
    const bytes = await store.get(key);
    const at = bytes ? Number(utf8Decode(bytes)) : NaN;
    if (Number.isFinite(at)) first.set(key.slice(FIRST_PREFIX.length), at);
  }
  return first;
}

async function loadWriters(store: StorageAdapter): Promise<BySpace> {
  const writers: BySpace = new Map();
  for (const key of await store.list(PREFIX)) {
    const [spaceId, day] = splitDayKey(key.slice(PREFIX.length));
    const bytes = await store.get(key);
    if (!spaceId || !bytes) continue;
    const hashes: unknown = JSON.parse(utf8Decode(bytes));
    if (!Array.isArray(hashes)) continue;
    const set = setFor(writers, spaceId, day);
    for (const hash of hashes) if (typeof hash === 'string') set.add(hash);
  }
  return writers;
}

/** A UTC day as the meter keys it: `2026-10-20` */
const dayOf = (seconds: number) =>
  new Date(Math.floor(seconds / DAY) * DAY * 1000).toISOString().slice(0, 10);

/** `<space>:<day>` into its parts; the space is empty when there is no day */
function splitDayKey(key: string): [string, string] {
  const at = key.lastIndexOf(':');
  return at <= 0 ? ['', ''] : [key.slice(0, at), key.slice(at + 1)];
}

function setFor(sets: BySpace, spaceId: string, day: string): Set<string> {
  let days = sets.get(spaceId);
  if (!days) sets.set(spaceId, (days = new Map()));
  let set = days.get(day);
  if (!set) days.set(day, (set = new Set()));
  return set;
}

const sizeOf = (days: Days | undefined) =>
  [...(days?.values() ?? [])].reduce((sum, set) => sum + set.size, 0);

/** How many distinct entries fall on days `within`, counting only `only` when given */
function distinct(days: Days | undefined, within: ReadonlySet<string>, only?: ReadonlySet<string>): number {
  const all = new Set<string>();
  for (const [day, set] of days ?? [])
    if (within.has(day)) for (const one of set) if (!only || only.has(one)) all.add(one);
  return all.size;
}

function dropEmpty(sets: BySpace): void {
  for (const [spaceId, days] of sets) if (days.size === 0) sets.delete(spaceId);
}
