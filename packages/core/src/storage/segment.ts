/**
 * A batch of record versions, as a mirror keeps them: exactly as they travel
 * on the wire — private bodies still sealed — packed into one immutable file.
 *
 * A segment's name sorts (a counter, for people reading a listing) and ends
 * in the hash of its bytes, so an upload retried after a timeout lands on the
 * same name, and two writers never write the same file differently.
 */
import type { Version } from '../types.js';
import { sha256 } from '../utils/hash.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isObject, isStoredVersion } from '../utils/guards.js';

export const SEGMENT_SUFFIX = '.seg';
/**
 * The segment format. 6 since who may do what is grants held by roles
 * (spec 03 §2): an older segment's access records are ones no peer reads
 * now, so a reader holds nothing for it instead.
 */
const SEGMENT_VERSION = 8;

/** Packs versions into a segment's bytes */
export function packSegment(versions: ReadonlyArray<Version>): Uint8Array {
  return utf8Encode(JSON.stringify({ v: SEGMENT_VERSION, versions }));
}

/** The versions in a segment; none for bytes that are not one */
export function unpackSegment(bytes: Uint8Array): Version[] {
  try {
    const parsed: unknown = JSON.parse(utf8Decode(bytes));
    if (!isObject(parsed) || parsed.v !== SEGMENT_VERSION || !Array.isArray(parsed.versions)) return [];
    return parsed.versions.filter(isStoredVersion);
  } catch {
    return [];
  }
}

/** The first 8 bytes of a segment's SHA-256, as hex: what its name ends with */
const hashOf = async (bytes: Uint8Array) =>
  Array.from((await sha256(bytes)).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');

/** A segment's file name: `000042-<first 16 hex of its hash>.seg` */
export async function segmentName(counter: number, bytes: Uint8Array): Promise<string> {
  return `${String(counter).padStart(6, '0')}-${await hashOf(bytes)}${SEGMENT_SUFFIX}`;
}

/**
 * Whether these are all of a segment's bytes: they hash to what its name says.
 * One still being written, or half delivered by a sync service, does not.
 */
export const isWholeSegment = async (key: string, bytes: Uint8Array) =>
  key.endsWith(`-${await hashOf(bytes)}${SEGMENT_SUFFIX}`);

/** Roughly how many bytes a version takes in a segment */
const versionSize = (version: Version) => utf8Encode(JSON.stringify(version)).length;

/** Splits versions into segments' worth: each closed once it reaches `bytes` */
export function* segmentBatches(versions: Iterable<Version>, bytes: number): Generator<Version[]> {
  let batch: Version[] = [];
  let size = 0;
  for (const version of versions) {
    batch.push(version);
    size += versionSize(version);
    if (size < bytes) continue;
    yield batch;
    batch = [];
    size = 0;
  }
  if (batch.length > 0) yield batch;
}
