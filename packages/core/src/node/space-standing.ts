/**
 * @module node/space-standing
 * Whether a version stands: signed, in this space, consistent with its first
 * version, at a key its account may write, and — by the access history —
 * written by someone allowed to. The same verdict for a version from a peer,
 * from a folder, or written here, and for one read back later.
 */
import { cached } from '../utils/map.js';
import type { Version } from '../types.js';
import { actsForAccount } from '../identity/abilities.js';
import { isStub } from '../schema/version.js';
import { chainProblem } from '../records/version.js';
import { keyKind, onePerForm, ownsKey } from '../records/key.js';
import { changedFixedField, onePerKey } from '../records/rules.js';
import { ACCESS_COLLECTIONS, isMember, may, type AccessState, type Needs } from '../space/roles.js';
import { RECORD_DELETE, RECORD_WRITE } from '../space/grants.js';
import {
  type Versions,
  type Standing,
  type Refusal,
  copyKey,
  idsKey,
  STANDS,
  ACCESS_LATER,
  type SpaceBase,
} from './space-versions.js';
import { type History, aboutItself } from './space-history.js';
import type { Rules } from './space-rules.js';

export function createStanding(
  deps: SpaceBase & { readonly versions: Versions; readonly history: History; readonly rules: Rules },
) {
  const { space, storage, keyring, versions, history, rules } = deps;
  const { copyProblem, judge, openBody, unreadable, firstOf, namedFirst } = versions;
  const { access, toEvent } = history;
  const { onePerKeying, definitionIn, inForce, rulesAt, tagProblem } = rules;

  // ─── Record keys ───────────────────────────────────────────────────
  //
  // Outside sys.*, a first version is at a key its account owns, or at a
  // shared onePer key (02 §4.1, `records/key.ts`), so no member can write a
  // first version at another's key and become its creator.

  /** Why a first version's key isn't one its account may write first, from the version alone; null when it may */
  async function keyProblem(version: Version, root: string): Promise<Refusal | null> {
    if (version.seq !== 0) return null;
    const kind = keyKind(version.key);
    // The protocol's own records keep keys of their own, so none can be current at someone's key.
    if (version.collection.startsWith('sys.'))
      return kind === null
        ? null
        : { ok: false, reason: 'A sys.* record is never at an owned or a one: key' };
    if (kind === 'shared') return null;
    if (kind === 'owned' && (await ownsKey(version.key, root))) return null;
    const reason =
      kind === 'owned'
        ? 'Its key belongs to another account'
        : 'A new record needs a key its account owns, or a shared one: key';
    return { ok: false, reason };
  }

  /**
   * Why a first version can't be at a key of a `onePer` key's form, shared
   * `one:<hex>` or owned `<owner>.one:<hex>` (02 §7.3): only a collection
   * whose rules have `onePer` gives one, owned when it names `@author`.
   * Judged from the definition alone, so peers that can't derive the key
   * agree. Null when it can, or when this node can't read the definition.
   */
  async function onePerKeyProblem(version: Version, state: AccessState): Promise<Refusal | null> {
    const form = onePerForm(version.key);
    if (version.seq !== 0 || !form || version.collection.startsWith('sys.')) return null;
    const id = await inForce(state, version.collection);
    const found = id ? await definitionIn(id) : 'missing';
    if (found === 'unreadable') return null;
    const onePer = typeof found === 'string' ? undefined : found.definition.rules?.onePer;
    if (!onePer) return { ok: false, reason: 'A one: key is only for a collection whose rules have onePer' };
    if (form === 'shared' && onePer.includes('@author'))
      return { ok: false, reason: 'A shared one: key is only for a onePer that does not name @author' };
    if (form === 'owned' && !onePer.includes('@author'))
      return { ok: false, reason: 'An owned one: key is only for a onePer that names @author' };
    return null;
  }

  /**
   * The command a version invokes, and its arguments (03 §5.2): a delete, or
   * a write with its body. `opaque` when this node can't read the body, so
   * policies on it are left to those who can.
   */
  async function invocationOf(version: Version, first: Version, root: string) {
    const byCreator = version.seq === 0 || (await judge(first)).root === root;
    const collection = version.collection;
    if (version.deleted) return { cmd: RECORD_DELETE, args: { collection, byCreator }, opaque: false };
    const opened = await openBody(version);
    const opaque = isStub(version) || unreadable(opened);
    const args = { collection, byCreator, ...(opaque ? {} : { body: opened.body }) };
    return { cmd: RECORD_WRITE, args, opaque };
  }

  /**
   * What a version asks of its author: in `sys.*`, a place; elsewhere, a grant
   * for what it does. `strict`: a body this node can't read holds no policy on it.
   */
  async function needsOf(
    version: Version,
    first: Version,
    root: string,
    options: { readonly strict?: boolean } = {},
  ): Promise<Needs> {
    if (version.collection.startsWith('sys.')) return (state) => isMember(state, root);
    const { cmd, args, opaque } = await invocationOf(version, first, root);
    return (state) => may(state, root, cmd, args, { opaque: opaque && !options.strict });
  }

  /** Whether this node reads the space's bodies: a public space, or a private one whose key it holds */
  const readsBodies = () => space.visibility !== 'private' || keyring.size > 0;

  const standings = new Map<string, Promise<Standing>>();

  /**
   * Whether a version stands: signed, in this space, consistent with its first
   * version, and — by the access history — written by someone allowed to.
   * The same verdict for a version from a peer, from a folder, or written
   * here, and for one read back later. `within`, for a version another cites:
   * judged as of what the citing version saw, so a change that came after it
   * can't undo a proof that held when it was made (02 §7.6).
   */
  async function standingOf(version: Version, within?: ReadonlyArray<string>): Promise<Standing> {
    const problem = await copyProblem(version);
    if (problem) return { ok: false, reason: problem };
    const cacheKey = within ? `${copyKey(version)}|${idsKey(within)}` : copyKey(version);
    // Only a verdict that stands is kept: one waiting changes when what it waits on arrives (02 §9.5).
    return cached(
      standings,
      cacheKey,
      () => judgeStanding(version, within),
      (standing) => standing.ok,
    );
  }

  /**
   * @param within For a version another cites: what the citing version saw.
   *   Only access changes among those can take it away.
   */
  async function judgeStanding(version: Version, within?: ReadonlyArray<string>): Promise<Standing> {
    // A version may only claim the space it actually sits in.
    if (version.space !== space.id) return { ok: false, reason: 'It belongs to a different space' };
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root)
      return { ok: false, reason: verdict.reason ?? 'Its signature does not check out' };
    const asAccount =
      deps.accountOnly || aboutItself(version.collection, version.body, verdict.root, version.author);
    if (asAccount && !actsForAccount(version.proof))
      return { ok: false, reason: "Its note doesn't let it act as the account itself" };
    const { history } = await access();

    if (ACCESS_COLLECTIONS.has(version.collection)) {
      const event = await toEvent(version);
      if (!event) return { ok: false, reason: 'It is not a well-formed change to who may do what' };
      const status = history.status(event.id);
      if (!status || status.status === 'waiting') return ACCESS_LATER;
      return status.status === 'applied' ? STANDS : { ok: false, reason: status.reason };
    }

    const first = await namedFirst(version);
    if (!first) return { ok: false, reason: 'Its first version has not arrived yet', later: true };
    if (!firstOf(version, first))
      return { ok: false, reason: "The first version it names is not this record's" };
    // Whose key it is depends on nothing that can change: refused, never withdrawn.
    const owned = await keyProblem(version, verdict.root);
    if (owned) return owned;

    const seen = version.seen ?? [];
    // Judged by the changes that stand; refused only by what its writer saw (03 §5.1).
    const state = history.at(seen, within);
    const wrote = history.seenAs(seen);
    if (!state || !wrote) return ACCESS_LATER;
    const form = await onePerKeyProblem(version, state);
    if (form) return form;
    // Rival definitions that differ give no rules, which must not mean anything goes (02 §6.3).
    if (state.contested.has(version.collection) && !(await inForce(state, version.collection)))
      return {
        ok: false,
        reason: `Rival definitions of ${version.collection} stand: nothing is written in it until a manager settles them`,
      };

    const root = verdict.root;
    const found = await rulesAt(state, version.collection);
    const rules = found?.rules;
    const needs = await needsOf(version, first, root);

    // The two refusals worth telling apart: not a member at all, and no grant for what it does.
    if (!isMember(wrote, root))
      return { ok: false, reason: 'Its author was not a member of this space, as of what it had seen' };
    if (!needs(wrote)) {
      return {
        ok: false,
        reason: `Its author holds no grant to ${version.deleted ? 'delete' : 'write'} this ${version.collection} record, as of what it had seen`,
      };
    }
    // A stub's grant may hold only because its body isn't here to read. A node that reads the
    // space waits for the body rather than take it on trust: it judges the whole version afresh.
    if (isStub(version) && readsBodies() && !(await needsOf(version, first, root, { strict: true }))(wrote))
      return {
        ok: false,
        reason: 'Its grant reads its body, which a stub does not carry',
        later: true,
        bodyNeeded: true,
      };
    // Written once: no later version, not even a delete.
    if (rules?.final && version.seq > 0)
      return {
        ok: false,
        reason: `A ${version.collection} record is final: it can't be edited or deleted`,
      };
    const judged = history.judge(
      {
        id: version.id,
        root,
        seen,
        writer: version.author,
        collection: version.collection,
        ...(version.log ? { line: version.log.n } : {}),
      },
      needs,
      within,
    );
    // Withdrawn by a later change: still judged on everything else, since it
    // is kept and others may cite it.
    if (!judged.ok && !judged.withdrawn) return judged;
    const content = await judgeContent(version, first, root, found);
    return judged.ok || !content.ok ? content : judged;
  }

  /** The rest of a version's standing: what its definition's topics and rules ask of what it says */
  async function judgeContent(
    version: Version,
    first: Version,
    root: string,
    found: Awaited<ReturnType<typeof rulesAt>>,
    options: { readonly tags?: boolean } = {},
  ): Promise<Standing> {
    const rules = found?.rules;
    if (found && !version.deleted && options.tags !== false) {
      const problem = await tagProblem(version, found.topics);
      if (problem) return problem;
    }
    if (!rules || version.deleted) return STANDS;
    // Their checks read the first version's body, so every peer must hold it,
    // however late it joins: a first version kept whole, not as a stub.
    if (version.seq === 0 && (rules.onePer || rules.fixed) && !version.retain)
      return {
        ok: false,
        reason: `A new ${version.collection} record must be kept whole: its rules are checked against it`,
      };
    if (version.seq === 0 && rules.onePer) {
      const opened = await openBody(version);
      const keying = onePerKeying();
      // Only a reader can compute a private space's onePer keys; the rest take it on the other checks.
      if (unreadable(opened) || !keying) return STANDS;
      const expected = await onePerKey(await keying, version.collection, rules.onePer, {
        root,
        links: opened.links,
        body: opened.body,
      });
      if (expected !== version.key) {
        return {
          ok: false,
          reason: `${version.collection} allows one per ${rules.onePer.join(' + ')} — its key must be derived from them`,
        };
      }
    }
    // Only against a first version kept whole, so a peer that joined after it
    // was superseded judges the same way as one that saw it.
    if (version.seq > 0 && rules.fixed?.length && first.retain) {
      const [now, then] = await Promise.all([openBody(version), openBody(first)]);
      if (now.body !== null && then.body !== null) {
        const field = changedFixedField(rules.fixed, then.body, now.body);
        if (field)
          return {
            ok: false,
            reason: `"${field}" is fixed once a ${version.collection} record is created`,
          };
      }
    }
    return STANDS;
  }

  /**
   * Whether a change to the access history may be stored. Not whether it
   * counts — that can change as other changes arrive, so every well-formed one
   * is kept and the replay decides. Only what never changes is asked: that
   * what it saw is here, and that its author is someone the history has heard
   * of, or holds an invite it has.
   */
  async function admissible(version: Version): Promise<Standing> {
    if (version.space !== space.id) return { ok: false, reason: 'It belongs to a different space' };
    if (!version.retain) return { ok: false, reason: 'A change to who may do what must be kept' };
    const event = await toEvent(version);
    if (!event)
      return {
        ok: false,
        reason: (await judge(version)).reason ?? 'It is not a well-formed change to who may do what',
      };
    const { history } = await access();
    if (!history.at(event.seen)) return ACCESS_LATER;
    const known =
      history.named(event.root) ||
      (event.kind === 'assign' && event.viaInvite !== undefined && history.knownInvite(event.viaInvite));
    return known ? STANDS : { ok: false, reason: 'Its author has never been a member of this space' };
  }

  /**
   * Whether a later version follows the version its `prev` names: the same
   * record, one more `seq`, the same first version. Asked on arrival, once
   * that version is held, so a writer can't skip ahead to a `seq` nobody can
   * outrank.
   */
  async function chainStanding(version: Version): Promise<Standing> {
    if (version.seq === 0 || typeof version.prev !== 'string') return STANDS;
    const previous = await storage.getVersion(version.prev);
    if (!previous) return { ok: false, reason: 'The version it follows has not arrived yet', later: true };
    const problem = chainProblem(version, previous);
    return problem ? { ok: false, reason: problem } : STANDS;
  }

  /** Whether a version from outside, checked to be what its id names and placed in its key's log, may be stored */
  async function admission(version: Version): Promise<Standing> {
    if (version.retain && isStub(version))
      return { ok: false, reason: 'A version its writer retained travels whole' };
    const chain = await chainStanding(version);
    if (!chain.ok) return chain;
    if (ACCESS_COLLECTIONS.has(version.collection)) return admissible(version);
    const standing = await standingOf(version);
    // Kept as its record's history; it counts only once whole, and its body is judged then.
    return !standing.ok && standing.bodyNeeded ? STANDS : standing;
  }

  return {
    standingOf,
    needsOf,
    admission,
    /** Verdicts that rest on the access history or the definitions, which changed */
    forget: () => standings.clear(),
  };
}

export type StandingJudge = ReturnType<typeof createStanding>;
