/**
 * @module body-cache
 * Version bodies kept in memory, the one used longest ago let go first. One
 * cache can serve many stores, so a node's memory is bounded by what it reads
 * often, not by how many spaces it holds. It is bounded by bytes, not by
 * count: a store of large bodies takes no more memory than one of small ones.
 */
import type { Version } from '../types.js';

export interface BodyCache {
  /** A store of its own in this cache: what one store keeps, apart from the others' */
  part(): BodyCachePart;
}

export interface BodyCachePart {
  get(id: string): Version | undefined;
  has(id: string): boolean;
  /** Keeps a body, as the one used last */
  set(version: Version): void;
  delete(id: string): void;
  /** Forgets everything this part kept */
  clear(): void;
}

/** About what a version takes in memory: its body's text, and its envelope */
function weigh(version: Version): number {
  const { body } = version;
  if (body === undefined || body === null) return ENVELOPE_BYTES;
  return ENVELOPE_BYTES + 2 * (typeof body === 'string' ? body.length : JSON.stringify(body).length);
}

/** An envelope's fields, ids and signature, held as strings */
const ENVELOPE_BYTES = 1024;

/**
 * A cache of at most `limit` bytes of bodies, shared by every part made from
 * it. A body larger than a quarter of it is not kept: it would push out many
 * others to save one read.
 * @param limit How many bytes all parts together keep
 */
export function createBodyCache(limit: number): BodyCache {
  /** By part, then id, with what each weighs */
  const held = new Map<string, { version: Version; bytes: number }>();
  let total = 0;
  let parts = 0;

  const drop = (key: string) => {
    const entry = held.get(key);
    if (!entry) return;
    held.delete(key);
    total -= entry.bytes;
  };

  return Object.freeze({
    part(): BodyCachePart {
      const prefix = `${parts++}:`;
      const keyOf = (id: string) => prefix + id;
      return Object.freeze({
        get(id: string) {
          const key = keyOf(id);
          const entry = held.get(key);
          if (entry) {
            held.delete(key);
            held.set(key, entry);
          }
          return entry?.version;
        },
        has: (id: string) => held.has(keyOf(id)),
        set(version: Version) {
          const key = keyOf(version.id);
          drop(key);
          const bytes = weigh(version);
          if (bytes > limit / 4) return;
          held.set(key, { version, bytes });
          total += bytes;
          while (total > limit) drop(held.keys().next().value!);
        },
        delete: (id: string) => drop(keyOf(id)),
        clear() {
          for (const key of [...held.keys()]) if (key.startsWith(prefix)) drop(key);
        },
      });
    },
  });
}
