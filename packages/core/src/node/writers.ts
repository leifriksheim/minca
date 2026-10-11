/**
 * @module node/writers
 * A key's writes in each collection of a space form one line: its log
 * (spec 02 §4.10).
 *
 * Each version a key signs in a space takes the next place in that key's line
 * for its collection there, naming the one before. Two versions at one place are a fork, which
 * only a key used in two places at once can make: a stolen key, or one copied
 * where it shouldn't be. So a node hands out each place once, one write at a
 * time per key and space, and remembers the last place it gave before the
 * version leaves it.
 *
 * A key made for this run lives as long as the node that made it, so its
 * places can be kept in memory: when the node stops, the key is gone with
 * them. A key that outlives the node — a claimed writer key, an agent's, an
 * app's, a host's — keeps its places beside it, or a restart would hand out a
 * place a second time. Such a key can be signing in more than one node at a
 * time: every tab of an app signs with the app's key. So each place is taken
 * under a lock shared by every tab and worker of the origin, and read afresh
 * from where it is kept, never from a copy in memory another tab has moved on.
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
   * Signs the next version of `did`'s log in a space, in a collection. `sign`
   * is given its place in the collection's line and returns the version, or
   * throws to give it back. Writes by one key in one
   * space go one at a time; the place is remembered before this returns, so
   * before the version can leave the node.
   */
  append(
    did: string,
    spaceId: string,
    collection: string,
    sign: (log: WriterLog) => Promise<Version>,
  ): Promise<Version>;
}

/** A key's places in one space: the last it took in each collection's line */
interface Places {
  readonly collections: Readonly<Record<string, Head>>;
}

const headKey = (did: string, spaceId: string) => `head/${did}/${spaceId}`;

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
 * Runs `work` holding a lock every context of this origin shares — tabs,
 * workers — where there are Web Locks. Where there are none (Node before 24),
 * every node in the process shares this one instead: the only nodes that can
 * share a key there are in one process, since the CLI locks its keys per
 * process.
 */
function exclusively<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(name, work);
  const run = (held.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
  held.set(name, run);
  void run.finally(() => held.get(name) === run && held.delete(name)).catch(() => {});
  return run;
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
    // A kept key's places are read where they are kept, every time: another node may share the key.
    if (store) return readPlaces(await store.get(key));
    return kept.get(key) ?? null;
  }

  return Object.freeze({
    append(did: string, spaceId: string, collection: string, sign: (log: WriterLog) => Promise<Version>) {
      const key = headKey(did, spaceId);
      const take = async () => {
        const places = await placesOf(did, spaceId);
        const log = after(places?.collections[collection]);
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
        // A key kept where other nodes can reach it takes each place under the lock they share.
        .then(() => (storeOf(did) ? exclusively(`weave-writer:${key}`, take) : take()));
      queues.set(key, run);
      return run;
    },
  });
}
