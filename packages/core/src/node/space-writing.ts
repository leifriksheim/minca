/**
 * @module node/space-writing
 * Writing to a space: signing a version, and refusing here, with the reason,
 * what every other peer would refuse.
 *
 * **A record keeps its key; changes are versions.** Editing a record writes its
 * next version — same key, `seq` one higher, `prev` naming the one replaced —
 * and deleting it writes a version marked deleted.
 */
import type { Link, Version } from '../types.js';
import type { Signer } from '../schema/signer.js';
import { accessRequirement, actsForAccount, noteGrants } from '../identity/abilities.js';
import { createVersion, isStub } from '../schema/version.js';
import { MAX_SEEN, nextVersion } from '../records/version.js';
import { keyKind, newRecordKey, onePerForm, ownedKey, ownsKey, RECORD_KEY_PATTERN } from '../records/key.js';
import { hasContract } from '../records/contracts.js';
import type { Writers } from './writers.js';
import { isSealedBody, sealBody } from '../privacy/space-encryption.js';
import {
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
  assignKey,
  removalKey,
  roleKey,
  stepDownKey,
  WARRANT_COLLECTION,
} from '../space/space-access.js';
import {
  ACCESS_COLLECTIONS,
  ACCESS_KINDS,
  isMember,
  may,
  replayAccess,
  rolesOf,
  type AccessHistory,
} from '../space/roles.js';
import { RECORD_DELETE, RECORD_WRITE } from '../space/grants.js';
import { fileRefsIn, MAX_FILES } from '../files/file-id.js';
import { CATALOG_COLLECTION } from '../schema/collection-def.js';
import { CARRIER_COLLECTION, MEMBERSHIP_COLLECTION, PROFILE_COLLECTION } from '../space/account-registry.js';
import { PASS_COLLECTION } from '../space/pass.js';
import { tagsFor } from '../records/topics.js';
import { isRecord } from '../utils/guards.js';
import type { NodeRecord, RecordContracts } from './types.js';
import {
  type Versions,
  sealedKeyId,
  NO_CHECKS,
  type ActiveSession,
  type SpaceBase,
} from './space-versions.js';
import { type History, aboutItself } from './space-history.js';
import type { Rules } from './space-rules.js';
import type { StandingJudge } from './space-standing.js';
import type { Checks } from './space-checks.js';
import type { Catalog } from './space-catalog.js';
import type { Index } from './space-index.js';
import type { Keys } from './space-keys.js';
/** Collections the node writes itself, through their own calls — never through `put` */
const MANAGED = new Set([
  MEMBERSHIP_COLLECTION,
  WARRANT_COLLECTION,
  PROFILE_COLLECTION,
  CARRIER_COLLECTION,
  PASS_COLLECTION,
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
  ...ACCESS_COLLECTIONS,
]);

/**
 * Access records a peer without the space key must still judge: who holds
 * which role decides every write. Kept in the clear even in a private space.
 * Collection definitions stay sealed: a peer that can't read the records has
 * no use for their rules.
 */
const IN_THE_CLEAR = new Set([
  ...Object.values(ACCESS_KINDS)
    .filter(({ clear }) => clear)
    .map(({ collection }) => collection),
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
]);

/**
 * Collections whose every version is kept whole. The access history is
 * replayed whole; a warrant's proof is read back after anything written over it.
 */
const ALWAYS_RETAINED = new Set([
  ...ACCESS_COLLECTIONS,
  WARRANT_COLLECTION,
  PROFILE_COLLECTION,
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
]);

/** Said when a key's note doesn't let it define collections — it can propose them instead */
export const CANNOT_DEFINE =
  "This key's note doesn't let it add or change collections. Propose them instead (collections_propose), and someone who may adds them.";
const CANNOT_CHANGE_ACCESS =
  "This key's note doesn't let it change who may do what in a space. Ask the person.";
const NOT_ACCOUNT = "This key's note doesn't let it change the account itself. Ask the person.";
export interface WritingDeps extends SpaceBase {
  readonly signer: Signer;
  readonly writers: Writers;
  readonly versions: Versions;
  readonly history: History;
  readonly rules: Rules;
  readonly standing: StandingJudge;
  readonly checks: Checks;
  readonly catalog: Catalog;
  readonly index: Index;
  readonly keys: Keys;
  /** A version this node signed is in the store: what follows from it */
  readonly stored: (version: Version) => Promise<void>;
}

export function createWriting(deps: WritingDeps) {
  const { record, keyring, storage, signer, session } = deps;
  const { space } = record;
  const { judge, openBody, genesisOf, consistent } = deps.versions;
  const { access, toEvent, accessGenesis } = deps.history;
  const { rulesAt, tagKey, derivedKey } = deps.rules;
  const { standingOf } = deps.standing;
  const { checksOf } = deps.checks;
  const { catalog, contentIssues } = deps.catalog;
  const { currentOf, view } = deps.index;
  const { currentKey } = deps.keys;
  /** An invite waiting to be used — forgotten here once it is, whatever the stored record still says */
  let waitingInvite = record.invite !== null;

  interface VersionFields {
    readonly key: string;
    readonly seq: number;
    readonly prev?: string;
    readonly genesis?: string;
  }

  /** Why this account cannot write here at all, or null when it can */
  async function cannotWrite(): Promise<string | null> {
    const { history } = await access();
    if (isMember(history.current, deps.rootDid)) return null;
    return waitingInvite
      ? `You've joined "${space.name}", but its invite hasn't reached this device yet — connect to someone in the space first`
      : `"${space.name}" was shared with you to view — you can't change it`;
  }

  /**
   * The heads a new version names: all of them, or past what a version may
   * name, first those its own standing rests on (its author's place, its
   * role, its collection's definition), then the latest applied. Naming fewer
   * is safe: what it leaves out it is judged as not having seen (03 §3.2).
   */
  async function seenFor(history: AccessHistory, collection: string): Promise<ReadonlyArray<string>> {
    const roles = rolesOf(history.current, deps.rootDid);
    const mine = [
      await removalKey(deps.rootDid),
      await stepDownKey(deps.rootDid),
      ...(await Promise.all(roles.map((role) => assignKey(deps.rootDid, role)))),
      ...roles.map(roleKey),
      `collection:${collection}`,
    ];
    return history.headsFor(mine, MAX_SEEN);
  }

  /** Signs and stores one version. A delete carries no body. */
  async function write<T>(
    collection: string,
    body: T | null,
    version: VersionFields,
    deleted = false,
    links: ReadonlyArray<Link> = [],
    options: { joining?: boolean; as?: ActiveSession } = {},
  ): Promise<Version> {
    const writer = options.as ?? session;
    const asAccount = deps.accountOnly || aboutItself(collection, body, deps.rootDid, writer.did);
    if (asAccount && !actsForAccount(writer.proof())) throw new Error(NOT_ACCOUNT);
    // Every peer would ignore it (see buildEvent); say why here instead.
    if (
      ACCESS_COLLECTIONS.has(collection) &&
      !noteGrants(writer.proof(), accessRequirement(space.id, collection, version.key))
    ) {
      throw new Error(collection === CATALOG_COLLECTION ? CANNOT_DEFINE : CANNOT_CHANGE_ACCESS);
    }
    // Every other copy would refuse it, so refuse it here rather than show a
    // change that exists on this device alone.
    if (!options.joining) {
      const problem = await cannotWrite();
      if (problem) throw new Error(problem);
    }

    let payload: unknown = null;
    let tags: string[] = [];
    // The files the body refers to, named on the outside so keepers fetch and keep them.
    const named = deleted ? [] : fileRefsIn(body);
    if (named.length > MAX_FILES) throw new Error(`A record names at most ${MAX_FILES} files`);
    if (!deleted) {
      // Refused here, where the writer can fix it. On arrival a misfit is kept
      // and flagged instead — see `conforms`.
      const issues = await contentIssues(collection, body, links);
      if (issues?.length) {
        throw new Error(
          `Not a valid ${collection}: ${issues.map((i) => (i.path === '/' ? i.message : `${i.path} ${i.message}`)).join('; ')}`,
        );
      }

      // Encrypt *before* signing: peers without the key still verify the
      // signature and relay the record, they just cannot read it.
      payload = body;
      if (space.visibility === 'private' && !IN_THE_CLEAR.has(collection)) {
        // Always the key the history names now: one someone removed still holds would do nothing.
        const key = currentKey((await access()).history.current);
        if (!key) {
          throw new Error(
            keyring.size
              ? `The key of "${space.name}" changed, and the new one hasn't reached this device yet — connect to someone in the space first`
              : 'This private space has no key on this node',
          );
        }
        // Body and links sealed together: a relay learns neither.
        const content = links.length ? { body, links } : { body };
        payload = await sealBody(content, key, { space: space.id, collection, key: version.key });
      }
      // Worked out from the body, with the key it is sealed with: what every reader will check.
      const topics = collection.startsWith('sys.')
        ? []
        : ((await catalog()).get(collection)?.definition.topics ?? []);
      if (topics.length) {
        const sealedWith = isSealedBody(payload) ? sealedKeyId(payload) : null;
        const key = tagKey(sealedWith);
        if (key) tags = await tagsFor(await key, collection, topics, body, links);
      }
    }

    // Whether superseded versions are kept is the writer's decision, carried
    // on the version — never each reader's, or nodes that had seen different
    // definitions would store different things and never converge. The access
    // history keeps everything: it is replayed whole. A first version under
    // `onePer` or `fixed` is kept whole, because those rules are checked against it.
    const definition = (await catalog()).get(collection)?.definition;
    const retain =
      ALWAYS_RETAINED.has(collection) ||
      definition?.history === 'all' ||
      (version.seq === 0 && !!(definition?.rules?.onePer || definition?.rules?.fixed)) ||
      // Every version under a contract: it reads the one before, and others cite it.
      (!deleted && hasContract(definition?.contract));

    // The next place in this key's line for the collection: given back if the version is refused below.
    const signed = await deps.writers.append(writer.did, space.id, collection, async (log) => {
      const { history, events: held } = await access();
      const seen = await seenFor(history, collection);
      // Checks in force as of the very point it names: a definition arriving meanwhile can't leave it unkept.
      const checkedThen = (() => {
        const then = history.at(seen);
        return then ? rulesAt(then, collection) : null;
      })();
      const then = await checkedThen;
      const keep = retain || (!deleted && hasContract(then?.contract));
      const made = await signer.sign(
        createVersion({
          author: writer.did,
          collection,
          space: space.id,
          body: payload,
          proof: writer.proof(),
          version,
          retain: keep,
          deleted,
          seen,
          // In the clear only where the body is: a private space sealed them above.
          ...(space.visibility === 'public' && !deleted && links.length ? { links } : {}),
          ...(tags.length ? { tags } : {}),
          ...(named.length ? { files: named } : {}),
          log,
        }),
        writer.key,
      );

      // The same verdict every other peer will reach: refused here, with the reason, rather than there.
      const judged = await judge(made);
      if (!judged.verified) throw new Error(judged.reason ?? 'This key may not write here.');
      if (ACCESS_COLLECTIONS.has(collection)) {
        const event = await toEvent(made);
        if (!event) throw new Error('That is not a well-formed change to who may do what');
        const status = (history.extend(event) ?? replayAccess(accessGenesis, [...held, event])).status(
          event.id,
        );
        if (status?.status !== 'applied')
          throw new Error(status?.status === 'dropped' ? status.reason : 'That change could not be made');
      } else {
        const stands = await standingOf(made);
        // Taken away by a change to its rules that came in after it saw the history: try again.
        if (!stands.ok && stands.withdrawn)
          throw Object.assign(new Error(stands.reason), { rulesMoved: true });
        if (!stands.ok) throw new Error(stands.reason);
        // Its checks, here, before anyone else sees it: peers would keep it, but no reader would count it.
        const passes = await checksOf(made);
        if ('pending' in passes) throw new Error('Versions it cites have not arrived yet');
        if ('unjudged' in passes) throw new Error(passes.unjudged);
        if (passes.passes === false) throw new Error(passes.reason);
      }
      return made;
    });
    await storage.addVersion(signed);
    await deps.stored(signed);
    return signed;
  }

  /**
   * How a record's newest version that stands fares under its checks: kept and
   * synced by every peer either way, counted by a reader only when it passes.
   */
  async function contractsFor(recordKey: string, versionId?: string): Promise<RecordContracts | null> {
    // A version named is judged even when the history leaves it out (a superseded delete, say).
    const named = versionId !== undefined ? await storage.getVersion(versionId) : null;
    const candidates =
      versionId === undefined ? await storage.history(recordKey) : named?.key === recordKey ? [named] : [];
    for (const version of candidates) {
      if (isStub(version)) continue;
      // One named whose first version hasn't arrived waits for it.
      if (!(await consistent(version))) {
        if (versionId !== undefined && version.seq > 0)
          return { version: version.id, passes: null, pending: true };
        continue;
      }
      const stands = await standingOf(version);
      // One named that waits for what it follows is pending, as a contract waiting on what it cites.
      if (!stands.ok && stands.later && versionId !== undefined)
        return { version: version.id, passes: null, pending: true };
      if (!stands.ok) continue;
      const verdict = await checksOf(version);
      if ('pending' in verdict) return { version: version.id, passes: null, pending: true };
      if ('unjudged' in verdict)
        return { version: version.id, passes: null, unjudged: true, reason: verdict.unjudged };
      return { version: version.id, ...verdict };
    }
    return null;
  }

  /** The live current version of a record, or a clear error. */
  async function requireLive(recordKey: string): Promise<Version> {
    const current = await currentOf(recordKey);
    if (!current || current.deleted) throw new Error(`No record ${recordKey} in this space`);
    return current;
  }

  /**
   * The fields for writing a key again: the version after the one that counts.
   * Where the store's newest version fails its checks, after the newest that
   * counts, or afresh as a first version when none does: a version that fails
   * can't make others build on it, or claim a key (a `onePer` key) for good.
   * Otherwise after whatever the store holds, counted or not.
   */
  async function after(recordKey: string): Promise<VersionFields> {
    const held = await storage.getCurrent(recordKey);
    if (!held) return { key: recordKey, seq: 0 };
    const verdict = (await standingOf(held)).ok ? await checksOf(held) : NO_CHECKS;
    // One that fails its checks, or waits for ever on what it cites, can't hold the key.
    if ('passes' in verdict && verdict.passes !== false) return nextVersion(held);
    // Waiting only for its own step before: continue it, rather than fork this record.
    if ('pending' in verdict && held.prev && !(await storage.getVersion(held.prev))) return nextVersion(held);
    const counted = await currentOf(recordKey);
    return counted ? nextVersion(counted) : { key: recordKey, seq: 0 };
  }

  async function writeFirst<T>(
    collection: string,
    body: T,
    recordKey: string,
    links: ReadonlyArray<Link>,
    as?: ActiveSession,
  ): Promise<Version> {
    const current = await currentOf(recordKey);
    if (current && !current.deleted)
      throw new Error(`A record ${recordKey} already exists — update it instead`);
    // Writing a key that was deleted brings it back: the next version after the delete.
    return write(collection, body, await after(recordKey), false, links, { as });
  }

  async function upsert<T>(
    collection: string,
    recordKey: string,
    body: T,
    options: { joining?: boolean } = {},
  ): Promise<NodeRecord<T>> {
    return view<T>(await write(collection, body, await after(recordKey), false, [], options));
  }

  async function removeKey(recordKey: string, as?: ActiveSession): Promise<void> {
    const current = await requireLive(recordKey);
    await write(current.collection, null, await after(current.key), true, [], { as });
  }

  const guard = (collection: string) => {
    if (MANAGED.has(collection)) throw new Error(`${collection} is written by the node itself`);
  };

  /**
   * Runs a write once more when its collection's rules changed while it was
   * being made — it saw the history before the change, so the change takes
   * it away (03 §5.2) — this time under the new rules: a key they derive,
   * what they keep whole, all worked out again.
   */
  async function underCurrentRules<R>(run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (error) {
      if (!(isRecord(error) && error.rulesMoved === true)) throw error;
      return run();
    }
  }

  async function putOnce<T>(
    collection: string,
    body: T,
    options: { key?: string; links?: ReadonlyArray<Link>; as?: ActiveSession },
  ): Promise<NodeRecord<T>> {
    guard(collection);
    if (options.key !== undefined && !RECORD_KEY_PATTERN.test(options.key)) {
      throw new Error('A record key is 1–128 characters of a–z, 0–9 and : . _ -');
    }
    const links = options.links ?? [];
    // One per something: the key is derived from it, so writing again is the next version of the same record.
    const onePer = (await catalog()).get(collection)?.definition.rules?.onePer;
    if (onePer && options.key === undefined) {
      const derived = await derivedKey(collection, onePer, { root: deps.rootDid, links, body });
      if (!derived)
        throw new Error(`${collection} is one per ${onePer.join(' + ')} — give it every one of those`);
      await keepsCollection(derived, collection);
      return view<T>(await write(collection, body, await after(derived), false, links, { as: options.as }));
    }
    const recordKey = await keyToWrite(collection, options.key, onePer);
    return view<T>(await writeFirst(collection, body, recordKey, links, options.as));
  }

  /**
   * Where a new record goes: a fresh key of this account's, or the key the
   * caller names. A name is put in this account's namespace (`profile` →
   * `<owner>.profile`); a key this account already owns is taken as it is.
   * Not a `one:` key outside a `onePer` collection, which every peer refuses
   * (02 §7.3), nor a key this node holds a record of another collection at.
   */
  async function keyToWrite(
    collection: string,
    chosen: string | undefined,
    onePer: ReadonlyArray<string> | undefined,
  ): Promise<string> {
    if (chosen === undefined) return newRecordKey(deps.rootDid);
    let recordKey: string;
    if (await ownsKey(chosen, deps.rootDid)) recordKey = chosen;
    else if (keyKind(chosen) === 'owned') throw new Error(`${chosen} belongs to another account`);
    else recordKey = keyKind(chosen) === 'shared' ? chosen : await ownedKey(deps.rootDid, chosen);
    if (onePerForm(recordKey) && !onePer)
      throw new Error(`${recordKey} is a onePer key, and ${collection} has no onePer`);
    await keepsCollection(recordKey, collection);
    return recordKey;
  }

  /**
   * Refuses a write at a key this node holds a record of another collection
   * at. Keys are unique in a space, and a record keeps its collection for
   * life (02 §4.1, §4.2), so the write could only be refused, or continue the
   * other record's chain.
   */
  async function keepsCollection(recordKey: string, collection: string): Promise<void> {
    const held = (await currentOf(recordKey)) ?? (await storage.getCurrent(recordKey));
    if (held && held.collection !== collection)
      throw new Error(
        `${recordKey} already holds a ${held.collection} record, and a key keeps its collection for life: ` +
          `choose a name that includes the collection`,
      );
  }

  /** Whether this account holds a grant, now, to do something to a record */
  async function mayNow(
    collection: string,
    action: 'create' | 'edit' | 'delete',
    first: Version | null,
  ): Promise<boolean> {
    const { history } = await access();
    const state = history.current;
    if (!isMember(state, deps.rootDid)) return false;
    if (collection.startsWith('sys.')) return true;
    const found = await rulesAt(state, collection);
    if (!found && state.contested.has(collection)) return false;
    if (found?.rules.final && action !== 'create') return false;
    const byCreator = action === 'create' || (!!first && (await judge(first)).root === deps.rootDid);
    // The body isn't known yet: a policy on it is decided when the version is written.
    return may(
      state,
      deps.rootDid,
      action === 'delete' ? RECORD_DELETE : RECORD_WRITE,
      { collection, byCreator },
      {
        opaque: action !== 'delete',
      },
    );
  }

  return {
    cannotWrite,
    upsert,
    removeKey,
    contractsFor,
    /** The invite this account waited on has been used */
    joined(): void {
      waitingInvite = false;
    },

    put: async <T>(
      collection: string,
      body: T,
      options: { key?: string; links?: ReadonlyArray<Link>; as?: ActiveSession } = {},
    ): Promise<NodeRecord<T>> => {
      return underCurrentRules(() => putOnce(collection, body, options));
    },

    update: async <T>(
      recordKey: string,
      body: T,
      options: { links?: ReadonlyArray<Link>; as?: ActiveSession } = {},
    ): Promise<NodeRecord<T>> => {
      return underCurrentRules(async () => {
        const current = await requireLive(recordKey);
        guard(current.collection);
        // Links carry over unless replaced: ticking a todo should not unhook it from anything.
        const links = options.links ?? (await openBody(current)).links;
        return view<T>(
          await write(current.collection, body, await after(recordKey), false, links, { as: options.as }),
        );
      });
    },

    remove: async (recordKey: string, options: { as?: ActiveSession } = {}): Promise<void> => {
      guard((await requireLive(recordKey)).collection);
      await underCurrentRules(() => removeKey(recordKey, options.as));
    },

    /**
     * The key a record with this body and these links has under its
     * collection's `onePer`, written by `account` (default this one): null
     * when the collection has none, or the body lacks a part it names.
     */
    onePerKey: async (
      collection: string,
      body: unknown,
      options: { links?: ReadonlyArray<Link>; account?: string; onePer?: ReadonlyArray<string> } = {},
    ): Promise<string | null> => {
      const onePer = options.onePer ?? (await catalog()).get(collection)?.definition.rules?.onePer;
      if (!onePer) return null;
      return derivedKey(collection, onePer, {
        root: options.account ?? deps.rootDid,
        links: options.links ?? [],
        body,
      });
    },

    can: async (action: 'create' | 'edit' | 'delete', target: string): Promise<boolean> => {
      if (action === 'create') return mayNow(target, 'create', null);
      const current = await currentOf(target);
      if (!current || current.deleted) return false;
      return mayNow(current.collection, action, await genesisOf(current));
    },
  };
}

export type Writing = ReturnType<typeof createWriting>;
