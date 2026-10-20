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

/** A key's parts as names in the directory; none may be empty */
function partsOf(key: string): string[] {
  const parts = key.split('/');
  if (parts.some((part) => part === '')) throw new Error(`Not a blob key: ${JSON.stringify(key)}`);
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

/** Whether a directory holds nothing */
async function isEmpty(dir: DirectoryHandleLike): Promise<boolean> {
  for await (const _ of dir.keys()) return false;
  return true;
}

/**
 * @param path Where under `root` the store keeps its keys, `/` separating
 *   directories, e.g. `accounts/<id>/stores/spaces`
 */
export function createDirectoryBlobStore(root: DirectoryHandleLike, path = ''): BlobStore {
  const baseNames = path.split('/').filter(Boolean).map(encodeKey);
  const base = () => find(root, baseNames);

  return Object.freeze({
    async get(key: string) {
      const parts = partsOf(key);
      const dir = await find(root, [...baseNames, ...parts.slice(0, -1)]);
      return dir ? readFolderFile(dir, parts.at(-1)!) : null;
    },

    async put(key: string, bytes: Uint8Array) {
      const parts = partsOf(key);
      await writeFolderFile(
        await resolvePath(root, [...baseNames, ...parts.slice(0, -1)]),
        parts.at(-1)!,
        bytes,
      );
    },

    async delete(key: string) {
      const parts = partsOf(key);
      const chain: DirectoryHandleLike[] = [];
      let dir = await base();
      for (const name of parts.slice(0, -1)) {
        if (!dir) return;
        chain.push(dir);
        dir = await find(dir, [name]);
      }
      if (!dir) return;
      await removeFile(dir, parts.at(-1)!);
      // A writer's directory goes with its last segment, and a space's with its last writer.
      for (let i = chain.length - 1; i >= 0; i--) {
        const child = await find(chain[i]!, [parts[i]!]);
        if (!child || !(await isEmpty(child))) break;
        await removeFile(chain[i]!, parts[i]!, true);
      }
    },

    async list(prefix: string) {
      const cut = prefix.lastIndexOf('/');
      const dirKey = prefix.slice(0, cut + 1);
      const start = await find(root, [...baseNames, ...(dirKey ? partsOf(dirKey.slice(0, -1)) : [])]);
      const keys: string[] = [];
      const walk = async (dir: DirectoryHandleLike, at: string): Promise<void> => {
        for await (const entry of dir.values()) {
          // Another writer's file mid-write is not an entry yet.
          if (entry.name.endsWith('.tmp')) continue;
          const key = at + decodeKey(entry.name);
          if (entry.kind === 'file') {
            if (key.startsWith(prefix)) keys.push(key);
          } else if (`${key}/`.startsWith(prefix)) {
            const child = await find(dir, [entry.name]);
            if (child) await walk(child, `${key}/`);
          }
        }
      };
      if (start) await walk(start, dirKey);
      return keys;
    },
  });
}
