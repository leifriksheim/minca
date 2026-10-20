/**
 * A StorageAdapter over a directory: one file per entry under `kv/`, one per
 * version under `versions/`.
 *
 * In a data folder only the registry is kept this way: a handful of sealed
 * entries per space, which every app and device given the folder reads. A
 * space's versions go into segments instead (`storage/blob/directory.ts`,
 * `node/stores.ts`), since a file per version and per entry is more files
 * than a synced drive or a bucket should be asked to carry.
 */

import type { StorageAdapter, BatchOp, Version } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { isStoredVersion } from '../utils/guards.js';

// ─── The slice of the File System Access API this module relies on ─────
//
// Declared structurally rather than taken from `lib.dom`, for two reasons: the
// async iterator methods live in the separate `DOM.AsyncIterable` lib that this
// project does not pull in, and writing the contract out makes it obvious what a
// test double has to provide.

export interface WritableFileLike {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<WritableFileLike>;
}

export interface DirectoryHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterableIterator<string>;
  /** Each entry, and whether it is a file or a directory */
  values(): AsyncIterableIterator<{ readonly kind: 'file' | 'directory'; readonly name: string }>;
}

const VERSION_SUFFIX = '.json';

/**
 * Percent-encodes a storage key into a filename.
 *
 * Only lowercase is left unescaped, which looks excessive until you remember
 * that macOS and Windows filesystems are case-insensitive by default: without
 * this, the keys `space:Abc` and `space:abc` would quietly become one file and
 * one of the two values would be lost.
 */
export function encodeKey(key: string): string {
  let out = '';
  for (const byte of utf8Encode(key)) {
    const char = String.fromCharCode(byte);
    out += /[a-z0-9._-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

/** Reverses {@link encodeKey}. */
export function decodeKey(name: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '%') {
      bytes.push(Number.parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  return utf8Decode(new Uint8Array(bytes));
}

/** Whether a rejection means "that file isn't there", which is usually not an error. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

/** Walks — and creates — a chain of subdirectories. */
export async function resolvePath(
  root: DirectoryHandleLike,
  segments: ReadonlyArray<string>,
): Promise<DirectoryHandleLike> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

/** Reads a file, treating absence as null rather than as a failure. */
export async function readFolderFile(dir: DirectoryHandleLike, name: string): Promise<Uint8Array | null> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Writes a file, replacing whatever was there. */
export async function writeFolderFile(
  dir: DirectoryHandleLike,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** Deletes a file (or a directory and everything in it), ignoring one that is already gone. */
export async function removeFile(dir: DirectoryHandleLike, name: string, recursive = false): Promise<void> {
  try {
    await dir.removeEntry(name, recursive ? { recursive } : undefined);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Opens a storage adapter backed by a directory.
 *
 * @param path Where to keep these files inside it, `/` separating
 *   subdirectories. The full path from the folder root, so that several
 *   accounts can each have a subtree of their own.
 */
export async function createFolderAdapter(root: DirectoryHandleLike, path: string): Promise<StorageAdapter> {
  const segments = path.split('/').filter(Boolean).map(encodeKey);
  if (segments.length === 0) {
    throw new Error('A folder adapter needs a path to live in.');
  }
  const base = await resolvePath(root, segments);
  const kvDir = await base.getDirectoryHandle('kv', { create: true });
  const versionsDir = await base.getDirectoryHandle('versions', { create: true });

  // A version never changes under its id, so caching it is free.
  const versions = new Map<string, Version>();
  const kvCache = new Map<string, Uint8Array | null>();

  async function readVersionFile(name: string): Promise<Version | null> {
    const bytes = await readFolderFile(versionsDir, name);
    if (!bytes) return null;
    try {
      const parsed: unknown = JSON.parse(utf8Decode(bytes));
      return isStoredVersion(parsed) ? parsed : null;
    } catch {
      // A half-written file from a writer that died mid-flush. It will either be
      // rewritten or stay unreadable; either way it is not ours to repair.
      return null;
    }
  }

  return Object.freeze({
    async get(key: string): Promise<Uint8Array | null> {
      const cached = kvCache.get(key);
      if (cached !== undefined) return cached;

      const bytes = await readFolderFile(kvDir, encodeKey(key));
      kvCache.set(key, bytes);
      return bytes;
    },

    async put(key: string, value: Uint8Array): Promise<void> {
      await writeFolderFile(kvDir, encodeKey(key), value);
      kvCache.set(key, value);
    },

    async delete(key: string): Promise<void> {
      await removeFile(kvDir, encodeKey(key));
      kvCache.set(key, null);
    },

    async list(prefix = ''): Promise<string[]> {
      const keys: string[] = [];
      for await (const name of kvDir.keys()) {
        const key = decodeKey(name);
        if (!key.startsWith(prefix)) continue;
        keys.push(key);
        // Another writer created it after this process looked and found
        // nothing. The file is on disk now, so the remembered miss is stale.
        if (kvCache.get(key) === null) kvCache.delete(key);
      }
      return keys;
    },

    async putVersion(version: Version): Promise<void> {
      await writeFolderFile(
        versionsDir,
        encodeKey(version.id) + VERSION_SUFFIX,
        utf8Encode(JSON.stringify(version)),
      );
      versions.set(version.id, version);
    },

    async getVersion(id: string): Promise<Version | null> {
      const known = versions.get(id);
      if (known) return known;

      const version = await readVersionFile(encodeKey(id) + VERSION_SUFFIX);
      if (version) versions.set(id, version);
      return version;
    },

    async deleteVersion(id: string): Promise<void> {
      await removeFile(versionsDir, encodeKey(id) + VERSION_SUFFIX);
      versions.delete(id);
    },

    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      for (const op of ops) {
        if (op.type === 'put') {
          await writeFolderFile(kvDir, encodeKey(op.key), op.value);
          kvCache.set(op.key, op.value);
        } else {
          await removeFile(kvDir, encodeKey(op.key));
          kvCache.set(op.key, null);
        }
      }
    },

    async close(): Promise<void> {
      versions.clear();
      kvCache.clear();
    },
  });
}
