import type { StorageAdapter, BatchOp, Version } from '../../src/types.js';

/**
 * An in-memory StorageAdapter, for tests and headless runtimes without IndexedDB.
 * @returns A StorageAdapter backed by Maps
 */
export function createMemoryAdapter(): StorageAdapter {
  const kv = new Map<string, Uint8Array>();
  const versions = new Map<string, Version>();

  return {
    async get(key) {
      return kv.get(key) ?? null;
    },
    async put(key, value) {
      kv.set(key, value);
    },
    async delete(key) {
      kv.delete(key);
    },
    async list(prefix = '') {
      return [...kv.keys()].filter((key) => key.startsWith(prefix));
    },
    async putVersion(version) {
      versions.set(version.id, version);
    },
    async getVersion(id) {
      return versions.get(id) ?? null;
    },
    async deleteVersion(id) {
      versions.delete(id);
    },
    async batch(ops: ReadonlyArray<BatchOp>) {
      for (const op of ops) {
        if (op.type === 'put') kv.set(op.key, op.value);
        else kv.delete(op.key);
      }
    },
    async close() {
      kv.clear();
      versions.clear();
    },
  };
}
