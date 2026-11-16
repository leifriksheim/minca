/**
 * @module node/writer-keys
 * A signing key that outlives the node, held by one node at a time.
 *
 * A key's writes in each collection of a space form one line (spec 02
 * §4.10). A node that makes a new key each time it starts begins new lines
 * each time; one that keeps its key keeps its lines for as long as the device
 * does. But a kept key must never sign in two places at once, or its lines
 * fork and what it signed from the fork on stops counting. So a key is kept
 * in a **slot**, claimed under a lock: a tab, worker or process that finds
 * the slot taken claims the next one. A key's places in its log are kept in the
 * slot with it — never in the account's stores, which may be a folder shared,
 * copied or restored elsewhere. `browserWriterKeys` in
 * `@minca/storage/indexeddb` keeps them in a browser.
 */

/** Where a lasting key's places in its logs are kept: beside the key */
export interface HeadStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
}

/** A key this node alone signs with, until it lets go */
export interface ClaimedWriter {
  readonly keys: CryptoKeyPair;
  readonly heads: HeadStore;
  /** Lets another node claim the slot. The node calls it when it closes. */
  release(): Promise<void>;
  /**
   * Forgets the key, so the slot's next claim makes a new one: for a key that
   * was revoked. Its places stay until then, so it may still sign this run.
   */
  forget(): Promise<void>;
}

/**
 * Where a node gets a lasting key. `claim` gives a key no one else is
 * signing with now, or null when it can't promise that — then the node makes
 * a key for this run alone, as it would without a source.
 */
export interface WriterKeySource {
  claim(): Promise<ClaimedWriter | null>;
}
