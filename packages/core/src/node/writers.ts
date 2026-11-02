/**
 * @module node/writers
 * A key's writes in each collection of a space form one line: its log
 * (spec 02 §4.10).
 *
 * Each version takes the next place in its key's line for its collection,
 * naming the one before. Two versions at one place are a fork, which only a
 * key used in two places at once can make. So a node hands out each place
 * once, one write at a time per key and space, and remembers it before the
 * version leaves.
 *
 * A key made for this run keeps its places in memory: they go with it. A key
 * that outlives the node keeps them beside it, or a restart would reuse a
 * place. Such a key can sign in several tabs at once, so each place is taken
 * under a lock every tab and worker shares, and read afresh where it is kept.
 */
import type { Version, WriterLog } from '../types.js';
import type { HeadStore } from './writer-keys.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';

/** The last place a key took in one collection's line */
interface Head {
  readonly n: number;
  readonly id: string;
}

export interface Writers {
  /**
   * Signs the next version of `did`'s log in a space's collection. `sign` gets
   * the place and returns the version, or throws to give it back. The place is
   * remembered before this returns. `holds` says whether the store holds a
   * version: the one at the last place must be there, or nothing is signed.
   */
  append(
    did: string,
    spaceId: string,
    collection: string,
    holds: (id: string) => Promise<boolean>,
    sign: (log: WriterLog) => Promise<Version>,
  ): Promise<Version>;
}

/** A key's places in one space: the last it took in each collection's line */
interface Places {
  readonly collections: Readonly<Record<string, Head>>;
}

/** Where a key's places in a space are kept. (The old `head/` keys held places no peer accepts any more.) */
const headKey = (did: string, spaceId: string) => `lines/${did}/${spaceId}`;

const isHead = (value: unknown): value is Head =>
  isRecord(value) &&
  typeof value.n === 'number' &&
  Number.isSafeInteger(value.n) &&
  typeof value.id === 'string';

function readPlaces(bytes: Uint8Array | null): Places | null {
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(bytes));
    if (!isRecord(parsed) || !isRecord(parsed.collections)) return null;
    const collections: Record<string, Head> = {};
    for (const [name, head] of Object.entries(parsed.collections)) if (isHead(head)) collections[name] = head;
    return { collections };
  } catch {
    return null;
  }
}

/** Locks held in this process, by name, where there are no Web Locks */
const held = new Map<string, Promise<unknown>>();

/**
 * Runs `work` under a lock every tab and worker of this origin shares. Without
 * Web Locks (Node before 24) the lock is per process, which is enough: the CLI
 * locks its keys per process.
 */
function exclusively<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(name, work);
  const run = (held.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
  held.set(name, run);
  void run.finally(() => held.get(name) === run && held.delete(name)).catch(() => {});
  return run;
}

/** How long a write waits for the version at its key's last place, signed by another tab and on its way to the store */
const IN_FLIGHT_MS = 3_000;

/**
 * Whether the store holds the version at a key's last place, waiting a little
 * for one another tab signed and is storing now.
 */
async function arrives(id: string, holds: (id: string) => Promise<boolean>): Promise<boolean> {
  const until = Date.now() + IN_FLIGHT_MS;
  while (!(await holds(id))) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** The next place after a head, or the first */
const after = (head: Head | undefined): WriterLog => (head ? { n: head.n + 1, prev: head.id } : { n: 0 });

/**
 * The logs of the keys one node signs with.
 * @param storeOf Where a key's places are kept, for a key that outlives the
 *   node; null for one that doesn't, whose places are kept in memory
 */
export function createWriters(storeOf: (did: string) => HeadStore | null): Writers {
  const kept = new Map<string, Places | null>();
  const queues = new Map<string, Promise<unknown>>();

  async function placesOf(did: string, spaceId: string): Promise<Places | null> {
    const key = headKey(did, spaceId);
    const store = storeOf(did);
    if (!store) return kept.get(key) ?? null;
    // Read afresh every time: another node may share the key.
    const stored = readPlaces(await store.get(key));
    // Behind what this node took itself means the store was emptied under it:
    // signing on would fork the line, so sign nothing.
    for (const [collection, head] of Object.entries(kept.get(key)?.collections ?? {}))
      if ((stored?.collections[collection]?.n ?? -1) < head.n)
        throw new Error('This key’s places were lost while it was signing, so it signs nothing more.');
    return stored;
  }

  return Object.freeze({
    append(
      did: string,
      spaceId: string,
      collection: string,
      holds: (id: string) => Promise<boolean>,
      sign: (log: WriterLog) => Promise<Version>,
    ) {
      const key = headKey(did, spaceId);
      const take = async () => {
        const places = await placesOf(did, spaceId);
        const head = places?.collections[collection];
        // Its own last version here, missing: the store was emptied or rolled back while the places
        // were kept, as a node whose folder goes when it stops does. Signing on would build on an
        // older version than its own, a twin in a line (09 §7.5): nothing until sync brings it back.
        // One this node signed itself is stored as soon as this returns.
        if (
          head &&
          head.id !== kept.get(key)?.collections[collection]?.id &&
          !(await arrives(head.id, holds))
        )
          throw new Error(
            `Its own last write in ${collection} isn't here yet; it writes there again once that has synced`,
          );
        const log = after(head);
        const version = await sign(log);
        const next: Places = {
          collections: { ...places?.collections, [collection]: { n: log.n, id: version.id } },
        };
        // Kept before the version can leave: a restart must never give these places again.
        await storeOf(did)?.put(key, utf8Encode(JSON.stringify(next)));
        kept.set(key, next);
        return version;
      };
      const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() => (storeOf(did) ? exclusively(`minca-writer:${key}`, take) : take()));
      queues.set(key, run);
      return run;
    },
  });
}
