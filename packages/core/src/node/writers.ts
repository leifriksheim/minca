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
   * Signs the next version of `did`'s log in a space. `sign` is given its
   * place and returns the version, or throws to give the place back. Writes
   * by one key in one space go one at a time; the place is remembered before
   * this returns, so before the version can leave the node.
   */
  append(did: string, spaceId: string, sign: (log: WriterLog) => Promise<Version>): Promise<Version>;
}

const headKey = (did: string, spaceId: string) => `head/${did}/${spaceId}`;

function readHead(bytes: Uint8Array | null): Head | null {
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(bytes));
    return isRecord(parsed) &&
      typeof parsed.n === 'number' &&
      Number.isSafeInteger(parsed.n) &&
      typeof parsed.id === 'string'
      ? { n: parsed.n, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

/**
 * The logs of the keys one node signs with.
 * @param storeOf Where a key's places are kept, for a key that outlives the
 *   node; null for one that doesn't, whose places are kept in memory
 */
export function createWriters(storeOf: (did: string) => HeadStore | null): Writers {
  const heads = new Map<string, Head | null>();
  const queues = new Map<string, Promise<unknown>>();

  async function headOf(did: string, spaceId: string): Promise<Head | null> {
    const key = headKey(did, spaceId);
    if (!heads.has(key)) {
      const store = storeOf(did);
      heads.set(key, store ? readHead(await store.get(key)) : null);
    }
    return heads.get(key) ?? null;
  }

  return Object.freeze({
    append(did: string, spaceId: string, sign: (log: WriterLog) => Promise<Version>) {
      const key = headKey(did, spaceId);
      const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const head = await headOf(did, spaceId);
          const log: WriterLog = head ? { n: head.n + 1, prev: head.id } : { n: 0 };
          const version = await sign(log);
          const next = { n: log.n, id: version.id };
          // Kept before the version can leave: a restart must never give this place again.
          await storeOf(did)?.put(key, utf8Encode(JSON.stringify(next)));
          heads.set(key, next);
          return version;
        });
      queues.set(key, run);
      return run;
    },
  });
}
