/**
 * @module encrypted-adapter
 * Encryption at rest for the parts of a store that would otherwise give the
 * whole folder away.
 *
 * A private space encrypts every body before signing, which protects it from
 * the relay and from peers who were never invited. It does not protect it from
 * anyone holding the folder, because the AES key for that space is written into
 * the same store as the ciphertext it opens. This closes that: the space key and
 * the space record go in sealed under a key derived from the account seed, so
 * they are readable only once the folder has actually been unlocked.
 *
 * Scoped deliberately narrowly. Versions and their index entries pass
 * straight through: bodies are already encrypted where it matters, files are
 * content addressed, and sealing them would cost the property that makes a folder worth
 * having — that you can open it and see what is in it. What stays legible is
 * each record's author, timestamp and collection, plus anything in a space its
 * owner made public.
 */

import type { StorageAdapter, BatchOp } from '../types.js';
import { openEnvelope, sealEnvelope } from '../identity/envelope.js';

/** The envelope label of a value sealed at rest; bound to `{ entry }`, its storage key */
const AT_REST_LABEL = 'weave/at-rest/v1';

/**
 * What gets sealed by default: every entry of the space registry — each
 * space, its key, the write secret of a shared one, this account's member key
 * for it and its relays — and nothing else.
 *
 * A prefix match, so each must end in its colon: `space:` does not cover
 * `spaceinvite:`, and an invite secret left out here is anyone-with-the-folder
 * joining a space in your place.
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
 * Wraps a storage adapter so that selected values are encrypted on the way in
 * and decrypted on the way out.
 *
 * Each value is an envelope bound to its storage key, so sealed values
 * cannot be swapped between entries. A value under a sealed prefix that does
 * not open is refused, not trusted: anyone who can write the folder could
 * otherwise plant a space, or a key, in the clear.
 *
 * @param inner The adapter doing the actual storing
 * @param key The account's local key (`deriveLocalKey`)
 * @param options Which keys to seal
 * @returns An adapter with the same contract
 */
export function createEncryptedAdapter(
  inner: StorageAdapter,
  key: CryptoKey,
  options?: EncryptedAdapterOptions,
): StorageAdapter {
  const prefixes = options?.prefixes ?? DEFAULT_ENCRYPTED_PREFIXES;

  const shouldSeal = (storageKey: string): boolean =>
    prefixes.some((prefix) => storageKey.startsWith(prefix));

  function seal(storageKey: string, value: Uint8Array): Promise<Uint8Array> {
    return sealEnvelope(key, AT_REST_LABEL, { entry: storageKey }, value);
  }

  async function unseal(storageKey: string, bytes: Uint8Array): Promise<Uint8Array> {
    const opened = await openEnvelope(key, AT_REST_LABEL, { entry: storageKey }, bytes);
    if (!opened)
      throw new Error(`${storageKey} should be sealed under this account, and is not — refusing it`);
    return opened;
  }

  return Object.freeze({
    async get(storageKey: string): Promise<Uint8Array | null> {
      const bytes = await inner.get(storageKey);
      if (!bytes || !shouldSeal(storageKey)) return bytes;
      return unseal(storageKey, bytes);
    },

    async put(storageKey: string, value: Uint8Array): Promise<void> {
      return inner.put(storageKey, shouldSeal(storageKey) ? await seal(storageKey, value) : value);
    },

    async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
      const prepared = await Promise.all(
        ops.map(async (op): Promise<BatchOp> =>
          op.type === 'put' && shouldSeal(op.key)
            ? { type: 'put', key: op.key, value: await seal(op.key, op.value) }
            : op,
        ),
      );
      return inner.batch(prepared);
    },

    // Key names are not sealed, so listing, deleting and existence checks are
    // unchanged. A space id is a content hash and gives nothing away; its name
    // and its key live in the value, which is sealed.
    delete: (storageKey: string) => inner.delete(storageKey),
    list: (prefix?: string) => inner.list(prefix),

    // Versions carry their own encryption where the space calls for it.
    putVersion: inner.putVersion.bind(inner),
    getVersion: (id: string) => inner.getVersion(id),
    deleteVersion: (id: string) => inner.deleteVersion(id),
    close: () => inner.close(),
  });
}
