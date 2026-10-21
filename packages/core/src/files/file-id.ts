/**
 * What names a file, and how what arrives is checked (spec 05 §16.6).
 *
 * A file is cut into chunks of `CHUNK` bytes. Its chunk list is the SHA-256
 * of each, in order; its id is the SHA-256 of its size and that list. So a
 * reader checks the list once against the id, then each chunk as it comes:
 * a video plays before it is whole, and a bad peer wastes at most a chunk.
 */
import type { Version } from '../types.js';
import { sha256 } from '../utils/hash.js';
import { bytesToHex, concatBytes } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';

/** A chunk, and the record size of the files' encryption: one record is one chunk */
export const CHUNK = 262_144;
/** The largest file, in bytes as stored */
const MAX_FILE_SIZE = 2 ** 31;
/** Files a version names that peers take */
export const MAX_FILES = 16;

/** A file as a version names it: its id and its size as stored */
export interface FileName {
  readonly hash: string;
  readonly size: number;
}

const HASH = /^[0-9a-f]{64}$/;

const isFileName = (value: unknown): value is FileName =>
  isRecord(value) &&
  typeof value.hash === 'string' &&
  HASH.test(value.hash) &&
  typeof value.size === 'number' &&
  Number.isSafeInteger(value.size) &&
  value.size >= 1 &&
  value.size <= MAX_FILE_SIZE;

/**
 * The files a version names, as every peer takes them: in order, the first
 * 16 well-formed entries with distinct ids; none on a delete. Never a reason
 * to refuse the version.
 */
export function filesOf(version: Pick<Version, 'deleted'> & { readonly files?: unknown }): FileName[] {
  if (version.deleted || !Array.isArray(version.files)) return [];
  const taken: FileName[] = [];
  const seen = new Set<string>();
  for (const entry of version.files) {
    if (taken.length === MAX_FILES) break;
    if (!isFileName(entry) || seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    taken.push({ hash: entry.hash, size: entry.size });
  }
  return taken;
}

/** How many chunks a file of this size has */
export const chunkCount = (size: number): number => Math.ceil(size / CHUNK);

/** How long chunk `index` of a file of this size is */
export const chunkLength = (size: number, index: number): number =>
  index < chunkCount(size) - 1 ? CHUNK : size - (chunkCount(size) - 1) * CHUNK;

/** The SHA-256 of each chunk, in order, concatenated */
export async function chunkListOf(bytes: Uint8Array): Promise<Uint8Array> {
  const hashes: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK) hashes.push(await sha256(bytes.subarray(at, at + CHUNK)));
  return concatBytes(...hashes);
}

/** A file's id: SHA-256 of its size, as 8 bytes big-endian, and its chunk list */
export async function fileIdOf(size: number, list: Uint8Array): Promise<string> {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(size));
  return bytesToHex(await sha256(concatBytes(length, list)));
}

/** Whether a chunk list is the one this file's id names: exactly its length, and giving the id */
export async function listFits(file: FileName, list: Uint8Array): Promise<boolean> {
  return list.length === 32 * chunkCount(file.size) && (await fileIdOf(file.size, list)) === file.hash;
}

/**
 * Whether these are the bytes of chunk `index`: its length, and the hash the
 * list gives it. Without a list, only a file of one chunk can be checked: by
 * its id.
 */
export async function chunkFits(
  file: FileName,
  list: Uint8Array | null,
  index: number,
  bytes: Uint8Array,
): Promise<boolean> {
  if (index < 0 || index >= chunkCount(file.size) || bytes.length !== chunkLength(file.size, index))
    return false;
  const hash = await sha256(bytes);
  if (list) return bytesToHex(hash) === bytesToHex(list.subarray(32 * index, 32 * index + 32));
  return chunkCount(file.size) === 1 && (await fileIdOf(file.size, hash)) === file.hash;
}

/**
 * The files a body refers to: every object in it shaped as a file reference
 * (`hash`, `size`, `key` and `salt`, as `addFile` gives one). What the node
 * names on a version it writes, so the envelope and the body agree.
 */
export function fileRefsIn(body: unknown): FileName[] {
  const found = new Map<string, FileName>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 32) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (isFileName(value) && typeof value.key === 'string' && typeof value.salt === 'string')
      found.set(value.hash, { hash: value.hash, size: value.size });
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(body, 0);
  return [...found.values()];
}
