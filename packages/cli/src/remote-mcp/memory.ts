/**
 * Where a session's node keeps what it holds: in memory, gone when the node
 * stops, and at most `budget` bytes all told, so a stranger's space can't
 * grow it without bound. A call that writes is done once the space's keepers
 * have it, so nothing in here is the only copy of anything said to be done.
 */
import type { BatchOp, StorageAdapter, StoreFactory, Version } from '@minca/core';

/** What a session's stores hold, at most: past it a write is refused, and the call says so */
const SESSION_BYTES = 32 * 1024 * 1024;

const encoder = new TextEncoder();

export interface BoundedMemory {
  readonly stores: StoreFactory;
  readonly budget: number;
  /** Bytes held now, in every store */
  used(): number;
  /** Forgets a store and what it holds, for a space closed for good: opened again, it starts empty */
  drop(path: string): void;
}

export function boundedMemory(budget = SESSION_BYTES): BoundedMemory {
  let used = 0;
  const adapters = new Map<string, { adapter: StorageAdapter; clear: () => void }>();

  function adapter() {
    let bytes = 0;
    const count = (change: number) => {
      if (change > 0 && used + change > budget)
        throw new Error(
          `This connection holds more than ${Math.round(budget / 1024 / 1024)} MB of these spaces`,
        );
      used += change;
      bytes += change;
    };
    const entries = new Map<string, Uint8Array>();
    const versions = new Map<string, { version: Version; size: number }>();
    const put = (key: string, value: Uint8Array) => {
      const old = entries.get(key);
      count(old ? value.length - old.length : value.length + key.length);
      entries.set(key, value);
    };
    const remove = (key: string) => {
      const value = entries.get(key);
      if (value) count(-(value.length + key.length));
      entries.delete(key);
    };
    const store: StorageAdapter = {
      get: async (key) => entries.get(key) ?? null,
      put: async (key, value) => put(key, value),
      delete: async (key) => remove(key),
      list: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
      putVersion: async (version) => {
        if (versions.has(version.id)) return;
        const size = encoder.encode(JSON.stringify(version)).length;
        count(size);
        versions.set(version.id, { version, size });
      },
      getVersion: async (id) => versions.get(id)?.version ?? null,
      deleteVersion: async (id) => {
        count(-(versions.get(id)?.size ?? 0));
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
    const clear = () => {
      used -= bytes;
      bytes = 0;
      entries.clear();
      versions.clear();
    };
    return { adapter: store, clear };
  }

  return {
    budget,
    stores: async (path) => {
      let found = adapters.get(path);
      if (!found) {
        found = adapter();
        adapters.set(path, found);
      }
      return found.adapter;
    },
    used: () => used,
    drop(path) {
      adapters.get(path)?.clear();
      adapters.delete(path);
    },
  };
}
