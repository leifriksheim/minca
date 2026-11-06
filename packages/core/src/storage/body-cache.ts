/**
 * @module body-cache
 * Version bodies kept in memory, the one used longest ago let go first. One
 * cache can serve many stores, so a node's memory is bounded by what it reads
 * often, not by how many spaces it holds.
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

/**
 * A cache of at most `limit` bodies, shared by every part made from it.
 * @param limit How many bodies all parts together keep
 */
export function createBodyCache(limit: number): BodyCache {
  /** By part, then id */
  const held = new Map<string, Version>();
  let parts = 0;
  return Object.freeze({
    part(): BodyCachePart {
      const prefix = `${parts++}:`;
      const keyOf = (id: string) => prefix + id;
      return Object.freeze({
        get(id: string) {
          const key = keyOf(id);
          const version = held.get(key);
          if (version) {
            held.delete(key);
            held.set(key, version);
          }
          return version;
        },
        has: (id: string) => held.has(keyOf(id)),
        set(version: Version) {
          const key = keyOf(version.id);
          held.delete(key);
          held.set(key, version);
          if (held.size > limit) held.delete(held.keys().next().value!);
        },
        delete: (id: string) => void held.delete(keyOf(id)),
        clear() {
          for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key);
        },
      });
    },
  });
}
