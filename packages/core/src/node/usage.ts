/**
 * @module node/usage
 * How much each space a host carries is used: how many accounts wrote there
 * and how many devices read, over a rolling window (spec 08 §1.1).
 *
 * The host sees both already: a version's note names its account in the
 * clear, and a socket's hello its session key. What it keeps to count them
 * is one set per space per UTC day. Writers are kept on disk, so a restart
 * does not count someone twice, as salted hashes rather than DIDs, so the
 * meter's own entries name nobody. Readers stay in memory: they only ever
 * hint, and a restart that forgets some counts fewer, never more.
 *
 * Not mirrored to the bucket. A lost disk counts from nothing again, which
 * errs toward a space staying free.
 */
import type { StorageAdapter } from '../types.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';

const DAY = 86_400;
const PREFIX = 'usage:';
const SALT_KEY = 'usage-salt';
const FIRST_PREFIX = 'first:';
/** Readers kept for one space over the whole window: past it the count stops growing, so made-up keys cost no more */
const MAX_READERS_A_SPACE = 10_000;
/** Readers kept for every space together, however many spaces someone makes to read */
const MAX_READERS = 1_000_000;

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

/** A UTC day as the meter keys it: `2026-10-20` */
const dayOf = (seconds: number) =>
  new Date(Math.floor(seconds / DAY) * DAY * 1000).toISOString().slice(0, 10);

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Opens the meter, reading back what it counted before a restart */
export async function createUsageMeter(config: UsageMeterConfig) {
  const { store } = config;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  let salt = await store.get(SALT_KEY);
  if (!salt) {
    salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await store.put(SALT_KEY, salt);
  }
  const salted = salt;

  const hashOf = async (spaceId: string, account: string) =>
    hex((await sha256(new Uint8Array([...salted, ...utf8Encode(`${spaceId}\n${account}`)]))).slice(0, 16));
  /** Each space's members, hashed, as last asked: hashed again only when they change */
  const memberHashes = new Map<string, { readonly members: string; readonly hashes: ReadonlySet<string> }>();
  const hashesOf = async (spaceId: string, members: ReadonlyArray<string>) => {
    const joined = members.join('\n');
    const known = memberHashes.get(spaceId);
    if (known?.members === joined) return known.hashes;
    const hashes = new Set(await Promise.all(members.map((member) => hashOf(spaceId, member))));
    memberHashes.set(spaceId, { members: joined, hashes });
    return hashes;
  };
  /** When the meter first saw each space, unix seconds */
  const first = new Map<string, number>();
  for (const key of await store.list(FIRST_PREFIX)) {
    const bytes = await store.get(key);
    const at = bytes ? Number(utf8Decode(bytes)) : NaN;
    if (Number.isFinite(at)) first.set(key.slice(FIRST_PREFIX.length), at);
  }

  /** Writers by space, then by day: hashes */
  const writers = new Map<string, Map<string, Set<string>>>();
  /** Readers by space, then by day: session DIDs, in memory only */
  const readers = new Map<string, Map<string, Set<string>>>();
  /** How many reader entries are kept, across every space and day */
  let kept = 0;
  const keptIn = (days: Map<string, Set<string>> | undefined) =>
    [...(days?.values() ?? [])].reduce((sum, set) => sum + set.size, 0);

  const setFor = (sets: Map<string, Map<string, Set<string>>>, spaceId: string, day: string) => {
    let days = sets.get(spaceId);
    if (!days) sets.set(spaceId, (days = new Map<string, Set<string>>()));
    let set = days.get(day);
    if (!set) days.set(day, (set = new Set<string>()));
    return set;
  };

  for (const key of await store.list(PREFIX)) {
    const rest = key.slice(PREFIX.length);
    const at = rest.lastIndexOf(':');
    const bytes = await store.get(key);
    if (at <= 0 || !bytes) continue;
    const kept: unknown = JSON.parse(utf8Decode(bytes));
    if (!Array.isArray(kept)) continue;
    const set = setFor(writers, rest.slice(0, at), rest.slice(at + 1));
    for (const one of kept) if (typeof one === 'string') set.add(one);
  }

  /** The days still inside the window, today included */
  const window = (): ReadonlySet<string> => {
    const today = now();
    return new Set(Array.from({ length: config.windowDays }, (_, back) => dayOf(today - back * DAY)));
  };

  const distinct = (
    days: Map<string, Set<string>> | undefined,
    within: ReadonlySet<string>,
    only?: ReadonlySet<string>,
  ) => {
    const all = new Set<string>();
    for (const [day, set] of days ?? [])
      if (within.has(day)) for (const one of set) if (!only || only.has(one)) all.add(one);
    return all.size;
  };

  // Writes to one day's entry one after another, so a later one never loses to an earlier.
  let writing: Promise<unknown> = Promise.resolve();
  const later = (work: () => Promise<void>): Promise<void> => {
    const next = writing.then(work, work);
    writing = next.catch(() => {});
    return next;
  };

  return Object.freeze({
    /** An account wrote in a space: counted once a day, whatever it wrote */
    async wrote(spaceId: string, account: string): Promise<void> {
      const day = dayOf(now());
      const hash = await hashOf(spaceId, account);
      const set = setFor(writers, spaceId, day);
      if (set.has(hash)) return;
      set.add(hash);
      await later(() => store.put(`${PREFIX}${spaceId}:${day}`, utf8Encode(JSON.stringify([...set]))));
    },

    /** A session key proved it may read a space */
    read(spaceId: string, session: string): void {
      if (kept >= MAX_READERS || keptIn(readers.get(spaceId)) >= MAX_READERS_A_SPACE) return;
      const set = setFor(readers, spaceId, dayOf(now()));
      if (set.has(session)) return;
      set.add(session);
      kept += 1;
    },

    /**
     * When the meter first saw a space, kept from now if it never did: what
     * arrives soon after is the host catching up on its history.
     */
    async firstSeen(spaceId: string): Promise<number> {
      const known = first.get(spaceId);
      if (known !== undefined) return known;
      const at = now();
      first.set(spaceId, at);
      await later(() => store.put(`${FIRST_PREFIX}${spaceId}`, utf8Encode(String(at))));
      return at;
    },

    /**
     * How a space was used over the window. With `members`, only the writers
     * among them count: one removed since counts no more.
     */
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
      for (const sets of [writers, readers])
        for (const [spaceId, days] of sets) {
          for (const day of [...days.keys()]) {
            if (within.has(day)) continue;
            if (sets === readers) kept -= days.get(day)?.size ?? 0;
            days.delete(day);
            if (sets === writers) await later(() => store.delete(`${PREFIX}${spaceId}:${day}`));
          }
          if (days.size === 0) sets.delete(spaceId);
        }
    },

    /** Forgets a space altogether */
    async forget(spaceId: string): Promise<void> {
      for (const day of writers.get(spaceId)?.keys() ?? [])
        await later(() => store.delete(`${PREFIX}${spaceId}:${day}`));
      writers.delete(spaceId);
      kept -= keptIn(readers.get(spaceId));
      readers.delete(spaceId);
      memberHashes.delete(spaceId);
      if (first.delete(spaceId)) await later(() => store.delete(`${FIRST_PREFIX}${spaceId}`));
    },

    /** Waits for what is being written */
    flushed: () => later(async () => {}),
  });
}
