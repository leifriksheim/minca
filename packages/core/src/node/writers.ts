/**
 * @module node/writers
 * Every key's writes in a space form one line: its log (spec 02 §4.10).
 *
 * Each version a key signs in a space takes the next place in that key's log
 * there, naming the one before. Two versions at one place are a fork, which
 * only a key used in two places at once can make: a stolen key, or one copied
 * where it shouldn't be. So a node hands out each place once, one write at a
 * time per key and space, and remembers the last place it gave before the
 * version leaves it.
 *
 * A session key lives as long as the node that made it, so its places can be
 * kept in memory: when the node stops, the key is gone with them. A key that
 * outlives the node — a claimed writer key, an agent's, a host's — keeps its
 * places beside it, or a restart would hand out a place a second time.
 */
import type { Version, WriterLog } from '../types.js';
import type { HeadStore } from './writer-keys.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';

/** The last place a key took in a space's log */
interface Head {
  readonly n: number;
  readonly id: string;
}

export interface Writers {
  /**
   * Signs the next version of `did`'s log in a space, in a collection. `sign`
   * is given its places — in the space's line and the collection's — and
   * returns the version, or throws to give them back. Writes by one key in one
   * space go one at a time; the places are remembered before this returns, so
   * before the version can leave the node.
   */
  append(
    did: string,
    spaceId: string,
    collection: string,
    sign: (log: WriterLog) => Promise<Version>,
  ): Promise<Version>;
}

/** A key's places in one space, kept in one record so no failure can leave the two lines out of step */
interface Places {
  readonly head: Head;
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
    if (!isRecord(parsed) || !isHead(parsed.head) || !isRecord(parsed.collections)) return null;
    const collections: Record<string, Head> = {};
    for (const [name, head] of Object.entries(parsed.collections)) if (isHead(head)) collections[name] = head;
    return { head: parsed.head, collections };
  } catch {
    return null;
  }
}

/** The next place after a head, or the first */
const after = (head: Head | undefined) => (head ? { n: head.n + 1, prev: head.id } : { n: 0 });

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
    if (!kept.has(key)) {
      const store = storeOf(did);
      kept.set(key, store ? readPlaces(await store.get(key)) : null);
    }
    return kept.get(key) ?? null;
  }

  return Object.freeze({
    append(did: string, spaceId: string, collection: string, sign: (log: WriterLog) => Promise<Version>) {
      const key = headKey(did, spaceId);
      const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const places = await placesOf(did, spaceId);
          const log: WriterLog = { ...after(places?.head), c: after(places?.collections[collection]) };
          const version = await sign(log);
          const next: Places = {
            head: { n: log.n, id: version.id },
            collections: { ...places?.collections, [collection]: { n: log.c.n, id: version.id } },
          };
          // Kept before the version can leave: a restart must never give these places again.
          await storeOf(did)?.put(key, utf8Encode(JSON.stringify(next)));
          kept.set(key, next);
          return version;
        });
      queues.set(key, run);
      return run;
    },
  });
}
