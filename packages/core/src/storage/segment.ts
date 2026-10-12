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
 * The segment format. 5 since a version's proof is a note in the UCAN 1.0 profile
 * (spec 01 §7): an older segment's versions carry notes no peer reads now,
 * so a reader holds nothing for it instead.
 */
const SEGMENT_VERSION = 5;

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

/** A segment's file name: `000042-<first 16 hex of its hash>.seg` */
export async function segmentName(counter: number, bytes: Uint8Array): Promise<string> {
  const hash = Array.from((await sha256(bytes)).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${String(counter).padStart(6, '0')}-${hash}${SEGMENT_SUFFIX}`;
}

/** Roughly how many bytes a version takes in a segment */
export const versionSize = (version: Version) => utf8Encode(JSON.stringify(version)).length;
