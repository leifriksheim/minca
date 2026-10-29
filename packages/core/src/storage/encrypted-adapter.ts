/**
 * @module encrypted-adapter
 * Encryption at rest for the entries that would give a whole folder away.
 *
 * A private space's bodies are already encrypted, but its key is written into
 * the same store. So the space registry — each space, its key and secrets — is
 * sealed under a key derived from the account seed, readable only once the
 * folder is unlocked. Versions pass straight through: their bodies are
 * encrypted where it matters, and a folder stays legible to whoever opens it.
 */

import type { StorageAdapter, BatchOp } from '../types.js';
import { openEnvelope, sealEnvelope } from '../identity/envelope.js';

/** The envelope label of a value sealed at rest; bound to `{ entry }`, its storage key */
const AT_REST_LABEL = 'minca/at-rest/v1';

/**
 * The space registry's prefixes: what is sealed by default. Each ends in its
 * colon, so `space:` does not cover `spaceinvite:`.
 */
export const DEFAULT_ENCRYPTED_PREFIXES: ReadonlyArray<string> = [
  'space:',
  'spacekey:',
  'spaceinvite:',
  'spacerole:',
  'spacememberkey:',
  'spacerelays:',
];

export interface EncryptedAdapterOptions {
  /** Key prefixes whose values are sealed. Defaults to {@link DEFAULT_ENCRYPTED_PREFIXES}. */
  readonly prefixes?: ReadonlyArray<string>;
}

/**
 * Wraps an adapter so values under the sealed prefixes are encrypted on the
 * way in and opened on the way out. Each is bound to its storage key, so they
 * can't be swapped between entries, and one that does not open is refused:
 * otherwise anyone who can write the folder could plant a space in the clear.
 *
 * @param key The account's local key (`deriveLocalKey`)
 */
export function createEncryptedAdapter(
  inner: StorageAdapter,
  key: CryptoKey,
  options?: EncryptedAdapterOptions,
): StorageAdapter {
  const prefixes = options?.prefixes ?? DEFAULT_ENCRYPTED_PREFIXES;
  const sealed = (entry: string) => prefixes.some((prefix) => entry.startsWith(prefix));

  const seal = (entry: string, value: Uint8Array) => sealEnvelope(key, AT_REST_LABEL, { entry }, value);

  async function unseal(entry: string, bytes: Uint8Array): Promise<Uint8Array> {
    const opened = await openEnvelope(key, AT_REST_LABEL, { entry }, bytes);
    if (!opened) throw new Error(`${entry} should be sealed under this account, and is not — refusing it`);
    return opened;
  }

  async function sealOp(op: BatchOp): Promise<BatchOp> {
    if (op.type !== 'put' || !sealed(op.key)) return op;
    return { type: 'put', key: op.key, value: await seal(op.key, op.value) };
  }

  return Object.freeze({
    async get(entry: string): Promise<Uint8Array | null> {
      const bytes = await inner.get(entry);
      if (!bytes || !sealed(entry)) return bytes;
      return unseal(entry, bytes);
    },
    async put(entry: string, value: Uint8Array): Promise<void> {
      return inner.put(entry, sealed(entry) ? await seal(entry, value) : value);
    },
    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      return inner.batch(await Promise.all(ops.map(sealOp)));
    },
    // Key names stay in the clear: a space id is a content hash and says nothing.
    delete: (entry: string) => inner.delete(entry),
    list: (prefix?: string) => inner.list(prefix),
    putVersion: inner.putVersion.bind(inner),
    getVersion: (id: string) => inner.getVersion(id),
    deleteVersion: (id: string) => inner.deleteVersion(id),
    close: () => inner.close(),
  });
}
