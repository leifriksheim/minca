/**
 * A StorageAdapter over a directory the user picked on their own disk.
 *
 * Unlike IndexedDB or OPFS it is not keyed by origin: every app given the
 * folder reads the same files, so an app is a view on the user's data rather
 * than the owner of a copy. The layout is legible, since the folder is theirs:
 *
 * ```
 * <folder>/
 *   accounts.json                    who has an account here
 *   accounts/<id>/account.json       that account's keys, locked
 *   accounts/<id>/stores/<name>/
 *     kv/<key>                       which version is current, what sync compares, space records
 *     versions/<cid>.json
 * ```
 *
 * **Versions are the truth; the entries are an index over them.** Version
 * files are immutable and named by their content hash, so two origins can
 * share a folder without locking; which version is current is derived, and
 * {@link reconcileFolder} puts it right.
 */

import type { StorageAdapter, BatchOp, Version } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { isStoredVersion } from '../utils/guards.js';

// The slice of the File System Access API used here. Declared rather than
// taken from `lib.dom`, whose async iterators live in a lib not pulled in.

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

/** What changed on disk since the last pass */
export interface FolderReload {
  /** Version ids that appeared — written by another origin, or another device */
  readonly added: ReadonlyArray<string>;
  /** Version ids whose files are gone */
  readonly removed: ReadonlyArray<string>;
}

export interface FolderAdapter extends StorageAdapter {
  /** Where inside the folder this adapter keeps its files */
  readonly namespace: string;
  /**
   * Re-reads the directory, picking up writes made by another origin or
   * device; the web has no change notification. Pair it with {@link reconcileFolder}.
   */
  reload(): Promise<FolderReload>;
  /** Every version id currently on disk, whatever the entries believe */
  listVersionIds(): Promise<ReadonlyArray<string>>;
}

const VERSION_SUFFIX = '.json';
const versionFile = (id: string) => encodeKey(id) + VERSION_SUFFIX;

/**
 * Percent-encodes a storage key into a filename. Upper case is escaped too:
 * on a case-insensitive filesystem `space:Abc` and `space:abc` would be one file.
 */
export function encodeKey(key: string): string {
  return Array.from(utf8Encode(key), encodeByte).join('');
}

function encodeByte(byte: number): string {
  const char = String.fromCharCode(byte);
  return /[a-z0-9._-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
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

/** Deletes a file, ignoring one that is already gone. */
export async function removeFile(dir: DirectoryHandleLike, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Opens a storage adapter backed by a directory on the user's disk. Versions
 * are held in memory too, or a query would read one file per record; so are
 * the entries' keys, or every listing would read the whole directory. Their
 * values are not: they include file chunks, and the disk's cache holds them.
 *
 * @param path Where to keep these files from the folder root, `/` separating
 *   subdirectories, so several accounts can each have a subtree.
 * @param options.shared Others write these entries as this reads them, and
 *   nothing reloads it: every read of an entry goes to the disk.
 */
export async function createFolderAdapter(
  root: DirectoryHandleLike,
  path: string,
  options: { readonly shared?: boolean } = {},
): Promise<FolderAdapter> {
  const segments = path.split('/').filter(Boolean).map(encodeKey);
  if (segments.length === 0) throw new Error('A folder adapter needs a path to live in.');
  const base = await resolvePath(root, segments);
  const kvDir = await base.getDirectoryHandle('kv', { create: true });
  const versionsDir = await base.getDirectoryHandle('versions', { create: true });

  const versions = new Map<string, Version>();
  /** The entries' keys, as of the last `reload` and this adapter's own writes since; none kept when shared */
  let keys = options.shared ? null : new Set<string>();
  /** Writes made while a reload lists the directory, which its listing may have missed: whether each key is there */
  let writtenDuringReload: Map<string, boolean> | null = null;

  async function listKeys(): Promise<string[]> {
    const found: string[] = [];
    for await (const name of kvDir.keys()) found.push(decodeKey(name));
    return found;
  }

  async function readVersionFile(name: string): Promise<Version | null> {
    const bytes = await readFolderFile(versionsDir, name);
    if (!bytes) return null;
    try {
      const parsed: unknown = JSON.parse(utf8Decode(bytes));
      return isStoredVersion(parsed) ? parsed : null;
    } catch {
      // Half written by a writer that died mid-flush: not ours to repair.
      return null;
    }
  }

  async function put(key: string, value: Uint8Array): Promise<void> {
    await writeFolderFile(kvDir, encodeKey(key), value);
    keys?.add(key);
    writtenDuringReload?.set(key, true);
  }

  async function remove(key: string): Promise<void> {
    await removeFile(kvDir, encodeKey(key));
    keys?.delete(key);
    writtenDuringReload?.set(key, false);
  }

  /** The reload running now: one at a time, so writes made during it are kept by exactly one */
  let reloading: Promise<FolderReload> | null = null;
  const reload = (): Promise<FolderReload> =>
    (reloading ??= reloadOnce().finally(() => {
      reloading = null;
    }));

  async function reloadOnce(): Promise<FolderReload> {
    const seen = new Set<string>();
    const added: string[] = [];

    for await (const name of versionsDir.keys()) {
      if (!name.endsWith(VERSION_SUFFIX)) continue;
      const id = decodeKey(name.slice(0, -VERSION_SUFFIX.length));
      seen.add(id);
      if (versions.has(id)) continue;

      const version = await readVersionFile(name);
      if (!version) continue;
      versions.set(id, version);
      added.push(id);
    }

    const removed = [...versions.keys()].filter((id) => !seen.has(id));
    for (const id of removed) versions.delete(id);

    // Built aside and swapped in whole: an entry must never read as missing while the directory is listed.
    if (keys) {
      writtenDuringReload = new Map();
      const listed = new Set(await listKeys());
      for (const [key, there] of writtenDuringReload) {
        if (there) listed.add(key);
        else listed.delete(key);
      }
      keys = listed;
      writtenDuringReload = null;
    }
    return { added, removed };
  }

  await reload();

  return Object.freeze({
    namespace: path,
    reload,

    async listVersionIds(): Promise<ReadonlyArray<string>> {
      return [...versions.keys()];
    },

    async get(key: string): Promise<Uint8Array | null> {
      return !keys || keys.has(key) ? readFolderFile(kvDir, encodeKey(key)) : null;
    },

    put,
    delete: remove,

    async list(prefix = ''): Promise<string[]> {
      return [...(keys ?? (await listKeys()))].filter((key) => key.startsWith(prefix));
    },

    async putVersion(version: Version): Promise<void> {
      await writeFolderFile(versionsDir, versionFile(version.id), utf8Encode(JSON.stringify(version)));
      versions.set(version.id, version);
    },

    async getVersion(id: string): Promise<Version | null> {
      const known = versions.get(id);
      if (known) return known;

      // Not in memory: another origin may have written it since the last reload.
      const version = await readVersionFile(versionFile(id));
      if (version) versions.set(id, version);
      return version;
    },

    async deleteVersion(id: string): Promise<void> {
      await removeFile(versionsDir, versionFile(id));
      versions.delete(id);
    },

    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      for (const op of ops) {
        if (op.type === 'put') await put(op.key, op.value);
        else await remove(op.key);
      }
    },

    async close(): Promise<void> {
      versions.clear();
      // Anything still in flight reads the disk again, never an empty index.
      keys = null;
    },
  });
}
