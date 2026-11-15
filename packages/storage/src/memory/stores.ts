/**
 * A StoreFactory in memory: one adapter per path, kept for the life of the
 * factory so a space closed and reopened sees the same data — like a disk.
 */
import type { StorageAdapter, StoreFactory } from '@minca/core';
import { createMemoryAdapter } from './adapter.js';

export function memoryStores(): StoreFactory & { readonly paths: () => ReadonlyArray<string> } {
  const adapters = new Map<string, StorageAdapter>();
  const factory = async (path: string) => {
    let adapter = adapters.get(path);
    if (!adapter) {
      adapter = createMemoryAdapter();
      adapters.set(path, adapter);
    }
    // Closing a space must not wipe what it wrote.
    return { ...adapter, close: async () => {} };
  };
  return Object.assign(factory, { paths: () => [...adapters.keys()] });
}
