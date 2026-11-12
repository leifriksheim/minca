/**
 * Where a session's node keeps what it holds: in memory, gone when the node
 * stops, and at most `budget` bytes all told, so a stranger's space can't
 * grow it without bound. A call that writes is done once the space's carriers
 * have it, so nothing in here is the only copy of anything said to be done.
 */
import type { BatchOp, StorageAdapter, StoreFactory, Version } from '@minca/core';

/** What a session's stores hold, at most: past it a write is refused, and the call says so */
const SESSION_BYTES = 32 * 1024 * 1024;

const encoder = new TextEncoder();

export function boundedMemory(budget = SESSION_BYTES): StoreFactory {
  let used = 0;
  const take = (bytes: number) => {
    if (used + bytes > budget)
      throw new Error(
        `This connection holds more than ${Math.round(budget / 1024 / 1024)} MB of these spaces`,
      );
    used += bytes;
  };
  const adapters = new Map<string, StorageAdapter>();

  function adapter(): StorageAdapter {
    const entries = new Map<string, Uint8Array>();
    const versions = new Map<string, { version: Version; size: number }>();
    const put = (key: string, value: Uint8Array) => {
      const old = entries.get(key);
      take(old ? value.length - old.length : value.length + key.length);
      entries.set(key, value);
    };
    const remove = (key: string) => {
      const value = entries.get(key);
      if (value) used -= value.length + key.length;
      entries.delete(key);
    };
    return {
      get: async (key) => entries.get(key) ?? null,
      put: async (key, value) => put(key, value),
      delete: async (key) => remove(key),
      list: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
      putVersion: async (version) => {
        if (versions.has(version.id)) return;
        const size = encoder.encode(JSON.stringify(version)).length;
        take(size);
        versions.set(version.id, { version, size });
      },
      getVersion: async (id) => versions.get(id)?.version ?? null,
      deleteVersion: async (id) => {
        used -= versions.get(id)?.size ?? 0;
        versions.delete(id);
      },
      batch: async (ops: ReadonlyArray<BatchOp>) => {
        for (const op of ops) {
          if (op.type === 'put') put(op.key, op.value);
          else remove(op.key);
        }
      },
      // Closing a space must not lose what it holds while the node runs: it may open it again.
      close: async () => {},
    };
  }

  return async (path) => {
    let found = adapters.get(path);
    if (!found) {
      found = adapter();
      adapters.set(path, found);
    }
    return found;
  };
}
