/**
 * @module node/space-rules
 * What a collection's definition says, as of a point in the access history,
 * and the keys its rules and topics derive from.
 *
 * A version is judged by the definition in force as of the access changes
 * it saw — the same on every peer, since everyone replays the same history.
 * A definition a peer cannot read (a private space, no key) cannot be
 * judged by; members judge instead.
 */
import { cached } from '../utils/map.js';
import type { Link, Version } from '../types.js';
import { canonicalize } from '../schema/version.js';
import { onePerKey, onePerSecret } from '../records/rules.js';
import type { AccessState } from '../space/roles.js';
import { CATALOG_COLLECTION, isStoredCollection, type StoredCollection } from '../schema/collection-def.js';
import { sameTags, tagsFor, topicKey } from '../records/topics.js';
import { type Versions, type Standing, sealedKeyId, type SpaceBase } from './space-versions.js';

export function createRules({
  space,
  storage,
  keyring,
  versions,
}: SpaceBase & { readonly versions: Versions }) {
  const { openBody } = versions;

  let oneSecret: Promise<CryptoKey> | null = null;
  /**
   * What this space's onePer keys are keyed with: its first space key in a
   * private space, its id in a public one (02 §7.3). Null when this node
   * holds no key of a private space.
   */
  function onePerKeying(): Promise<CryptoKey> | null {
    if (oneSecret) return oneSecret;
    if (space.visibility !== 'private') return (oneSecret = onePerSecret({ spaceId: space.id }));
    const first = space.encryptionKeyId ? keyring.get(space.encryptionKeyId) : undefined;
    return first ? (oneSecret = onePerSecret({ spaceKey: first.raw })) : null;
  }

  /** The key `put` writes a body at under a collection's `onePer`, for `root`; null when a part it names is missing */
  async function derivedKey(
    collection: string,
    onePer: ReadonlyArray<string>,
    record: { root: string; links: ReadonlyArray<Link>; body: unknown },
  ): Promise<string | null> {
    const keying = onePerKeying();
    if (!keying) throw new Error('This private space has no key on this node');
    return onePerKey(await keying, collection, onePer, record);
  }

  type Definition = { readonly definition: StoredCollection } | 'missing' | 'unreadable' | 'invalid';
  const definitions = new Map<string, Promise<Definition>>();

  /** The definition held in one version of `sys.collection` */
  function definitionIn(id: string): Promise<Definition> {
    // Something missing may turn up; only settled answers are kept.
    return cached(
      definitions,
      id,
      async (): Promise<Definition> => {
        const version = await storage.getVersion(id);
        if (!version) return 'missing';
        if (version.collection !== CATALOG_COLLECTION || version.deleted) return 'invalid';
        const opened = await openBody(version);
        if (opened.body === null) return 'unreadable';
        const body = opened.body;
        if (!isStoredCollection(body) || version.key !== `collection:${body.name}`) return 'invalid';
        return { definition: body };
      },
      (answer) => answer !== 'missing',
    );
  }

  /**
   * The id of the definition in force for a collection in one state of the
   * history (02 §6.3): the replay's, or, while rival first definitions stand,
   * the lowest of them only when they all say the same, so no ground id picks
   * the rules. One this node can't read when it can't read them all; null
   * when none is in force.
   */
  async function inForce(state: AccessState, collection: string): Promise<string | null> {
    const entry = state.definitions.get(collection);
    if (entry) return entry.event;
    const rivals = state.contested.get(collection);
    if (!rivals?.length) return null;
    const found = await Promise.all(rivals.map((id) => definitionIn(id)));
    const unreadable = rivals.find((_, i) => found[i] === 'unreadable');
    if (unreadable) return unreadable;
    const said = new Set(found.map((one) => (typeof one === 'string' ? one : canonicalize(one.definition))));
    return said.size === 1 && typeof found[0] !== 'string' ? rivals[0]! : null;
  }

  /** The rules and topics in force for a collection in one state of the history — null when there are none to judge by */
  async function rulesAt(
    state: AccessState,
    collection: string,
  ): Promise<{
    rules: NonNullable<StoredCollection['rules']>;
    topics: ReadonlyArray<string>;
    contract: unknown;
  } | null> {
    if (collection.startsWith('sys.')) return null;
    const id = await inForce(state, collection);
    if (!id) return null;
    const found = await definitionIn(id);
    return typeof found === 'string'
      ? null
      : {
          rules: found.definition.rules ?? {},
          topics: found.definition.topics ?? [],
          contract: found.definition.contract,
        };
  }

  // ─── Topic tags ────────────────────────────────────────────────────
  //
  // Keyed from the key a record's body was sealed with, in a private space;
  // from the space id in a public one (`records/topics.ts`).

  const topicKeys = new Map<string, Promise<CryptoKey>>();
  /** The tag key for one of the space's keys, or the public one; null when this node doesn't hold that key */
  function tagKey(keyId: string | null): Promise<CryptoKey> | null {
    const name = keyId ?? 'public';
    let found = topicKeys.get(name);
    if (!found) {
      const held = keyId === null ? null : keyring.get(keyId);
      if (keyId !== null && !held) return null;
      found = topicKey(held ? { spaceKey: held.raw } : { spaceId: space.id });
      topicKeys.set(name, found);
    }
    return found;
  }

  /**
   * Why a version's tags don't match its body under the topics in force, or
   * null when they do — or when this node can't read the body to tell.
   */
  async function tagProblem(version: Version, topics: ReadonlyArray<string>): Promise<Standing | null> {
    if (topics.length === 0 && !version.tags?.length) return null;
    const opened = await openBody(version);
    if (opened.body === null) return null;
    const key = tagKey(opened.encrypted ? sealedKeyId(version.body) : null);
    if (!key) return null;
    const expected = await tagsFor(await key, version.collection, topics, opened.body, opened.links);
    return sameTags(version.tags, expected)
      ? null
      : { ok: false, reason: `Its topic tags don't match what it says` };
  }

  return {
    onePerKeying,
    derivedKey,
    definitionIn,
    inForce,
    rulesAt,
    tagKey,
    tagProblem,
    /** A definition this node couldn't read may open now */
    forgetDefinitions: () => definitions.clear(),
  };
}

export type Rules = ReturnType<typeof createRules>;
