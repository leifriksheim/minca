/**
 * A blob store in a directory: a data folder the person picked, or a
 * directory on disk. Each `/`-separated part of a key is a directory and the
 * last one a file, every part named as a data folder names its files (spec 05
 * §14.2), so a key can't reach outside the directory.
 */
import type { BlobStore } from '../blob-store.js';
import {
  decodeKey,
  encodeKey,
  isNotFound,
  readFolderFile,
  removeFile,
  resolvePath,
  writeFolderFile,
  type DirectoryHandleLike,
} from '../folder-adapter.js';

/** Whether a key's part can stand as one name in a directory */
const isKeyPart = (part: string) => part !== '' && part !== '.' && part !== '..' && !/[/\\\0]/.test(part);

/** A key's parts as names in the directory; each must be one */
function partsOf(key: string): string[] {
  const parts = key.split('/');
  if (!parts.every(isKeyPart)) throw new Error(`Not a blob key: ${JSON.stringify(key)}`);
  return parts.map(encodeKey);
}

/** The directory down these names, or null if one is missing */
async function find(
  dir: DirectoryHandleLike,
  names: ReadonlyArray<string>,
): Promise<DirectoryHandleLike | null> {
  let current = dir;
  for (const name of names) {
    try {
      current = await current.getDirectoryHandle(name);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  return current;
}

/**
 * @param path Where under `root` the store keeps its keys, `/` separating
 *   directories, e.g. `accounts/<id>/stores/spaces`
 */
export function createDirectoryBlobStore(root: DirectoryHandleLike, path = ''): BlobStore {
  const baseNames = path.split('/').filter(Boolean).map(encodeKey);

  /** The names of the directories a key's file sits in, and of the file */
  function locate(key: string): { dirs: string[]; file: string } {
    const parts = partsOf(key);
    const file = parts.pop()!;
    return { dirs: [...baseNames, ...parts], file };
  }

  return Object.freeze({
    async get(key: string) {
      const { dirs, file } = locate(key);
      const dir = await find(root, dirs);
      return dir ? readFolderFile(dir, file) : null;
    },

    async put(key: string, bytes: Uint8Array) {
      const { dirs, file } = locate(key);
      await writeFolderFile(await resolvePath(root, dirs), file, bytes);
    },

    async delete(key: string) {
      const { dirs, file } = locate(key);
      const dir = await find(root, dirs);
      if (dir) await removeFile(dir, file);
    },

    async list(prefix: string) {
      const dirKey = prefix.slice(0, prefix.lastIndexOf('/') + 1);
      const start = await find(root, [...baseNames, ...(dirKey ? partsOf(dirKey.slice(0, -1)) : [])]);
      const keys: string[] = [];
      if (start) await collect(start, dirKey, prefix, keys);
      return keys;
    },
  });
}

/** Adds to `keys` every key under `dir` (named `at`) that starts with `prefix` */
async function collect(dir: DirectoryHandleLike, at: string, prefix: string, keys: string[]): Promise<void> {
  for await (const entry of dir.values()) {
    // Another writer's file mid-write is not an entry yet.
    if (entry.name.endsWith('.tmp')) continue;
    const part = decodeKey(entry.name);
    // A name no key could have made is not one of ours.
    if (!isKeyPart(part)) continue;
    const key = at + part;
    if (entry.kind === 'file') {
      if (key.startsWith(prefix)) keys.push(key);
      continue;
    }
    if (!`${key}/`.startsWith(prefix)) continue;
    const child = await find(dir, [entry.name]);
    if (child) await collect(child, `${key}/`, prefix, keys);
  }
}
