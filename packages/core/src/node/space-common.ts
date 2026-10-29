/**
 * @module node/space-common
 * Small helpers the parts of an open space share (`node/space-runtime.ts`).
 */
import { noteGrants } from '../identity/abilities.js';
import { isStub } from '../schema/version.js';
import type { Version } from '../types.js';

/**
 * What the caches of verdicts on a version are keyed by: its id and
 * signature, which a stub shares with the whole version, and which of the two
 * it is. A verdict on a stub never stands for the whole.
 */
export const copyKey = (version: Version) =>
  `${version.id}|${version.signature}|${isStub(version) ? 'stub' : 'whole'}`;

/** A set of ids as one cache key */
export const idsKey = (ids: ReadonlyArray<string>) => [...new Set(ids)].sort().join(',');

export const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Sets a value in a map that lets its oldest entry go past `max` */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  const oldest = map.keys().next();
  if (map.size > max && !oldest.done) map.delete(oldest.value);
}

/**
 * Whether a proof would let its key do anything in a space beyond writing
 * records: define a collection there, or change who may do what.
 */
export const grantsBeyondRecords = (proof: unknown, spaceId: string, cmd: string) =>
  noteGrants(proof, { space: spaceId, cmd, args: { space: spaceId } });
