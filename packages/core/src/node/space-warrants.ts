/**
 * @module node/space-warrants
 * A version no honest writer could have signed, judged as of what it says
 * it had seen, is proof against its account. A peer that refuses one writes
 * it down for every member, once per account (docs/warrants.md).
 */
import type { Version } from '../types.js';
import { isStub, stubOf } from '../schema/version.js';
import { chainProblem } from '../records/version.js';
import { newRecordKey } from '../records/key.js';
import { knownKind, readWarrant, type Warrant, type WarrantKind } from '../records/warrant.js';
import { WARRANT_COLLECTION } from '../space/space-access.js';
import { ACCESS_COLLECTIONS, isMember, refusal, type AccessState } from '../space/roles.js';
import type { FlaggedAccount } from './types.js';
import { type Versions, copyKey, type SpaceBase } from './space-versions.js';
import type { History } from './space-history.js';
import type { Rules } from './space-rules.js';
import type { StandingJudge } from './space-standing.js';

type WarrantVerdict = 'holds' | 'false' | 'later' | 'unjudgeable';

export interface WarrantsDeps extends SpaceBase {
  readonly versions: Versions;
  readonly history: History;
  readonly rules: Rules;
  readonly standing: StandingJudge;
  readonly upsert: (collection: string, recordKey: string, body: unknown) => Promise<unknown>;
  readonly cannotWrite: () => Promise<string | null>;
}

export function createWarrants(deps: WarrantsDeps) {
  const { space, storage, upsert, cannotWrite } = deps;
  const { judge, openBody, previousOf } = deps.versions;
  const { access, buildEvent, ownView } = deps.history;
  const { rulesAt } = deps.rules;
  const { standingOf, needsOf } = deps.standing;

  /** Whether a version's account is one the space has known: only those can be warranted, so a stranger minting keys costs nobody a write */
  async function accountable(version: Version): Promise<string | null> {
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root || version.space !== space.id) return null;
    return (await access()).history.named(verdict.root) ? verdict.root : null;
  }

  /** Whether a version broke a rule of its standing, as of what it had seen: no place, or `who` or `final` against it */
  async function standingBroken(version: Version, root: string): Promise<WarrantVerdict> {
    const state = await ownView(version.seen ?? []);
    if (!state) return 'later';
    return standingBrokenIn(state, version, root);
  }

  /** The same check, in a given state */
  async function standingBrokenIn(
    state: AccessState,
    version: Version,
    root: string,
  ): Promise<WarrantVerdict> {
    if (!isMember(state, root)) return 'holds';
    if (version.collection.startsWith('sys.')) return 'false';
    const found = await rulesAt(state, version.collection);
    if (found?.rules.final && version.seq > 0) return 'holds';
    // An edit's grant may rest on whose record it is; only a first version is judged here.
    if (version.seq !== 0) return 'false';
    const needs = await needsOf(version, version, root);
    return needs(state) ? 'false' : 'holds';
  }

  /** Whether proof of one kind holds: the offending version first, then what checking it needs */
  async function evidenceHolds(kind: string, evidence: ReadonlyArray<Version>): Promise<WarrantVerdict> {
    // A kind this peer doesn't know flags nobody.
    if (!knownKind(kind)) return 'false';
    const [offending, context] = evidence;
    if (!offending || !(await accountable(offending))) return 'false';
    const root = (await judge(offending)).root!;
    switch (kind) {
      case 'chain': {
        if (!context || 'body' in offending || 'body' in context) return 'false';
        if (!(await judge(context)).verified || context.id !== offending.prev) return 'false';
        return chainProblem(offending, context) ? 'holds' : 'false';
      }
      case 'standing':
        if (
          context ||
          'body' in offending ||
          ACCESS_COLLECTIONS.has(offending.collection) ||
          offending.collection === WARRANT_COLLECTION
        )
          return 'false';
        return standingBroken(offending, root);
      case 'access': {
        if (context || !ACCESS_COLLECTIONS.has(offending.collection) || !('body' in offending))
          return 'false';
        const event = await buildEvent(offending);
        if (!event) return 'false';
        const state = await ownView(event.seen);
        if (!state) return 'later';
        return refusal(event, state) ? 'holds' : 'false';
      }
    }
  }

  /** Whether a warrant record proves what it says, against the account its key names, and is its writer's own */
  async function warrantVerdict(version: Version): Promise<WarrantVerdict> {
    const cacheKey = copyKey(version);
    const known = judgedWarrants.get(cacheKey);
    if (known) return known;
    const warrant = await warrantShape(version);
    if (warrant === 'unnamed') return 'false';
    const verdict = warrant ? await evidenceHolds(warrant.kind, warrant.evidence) : 'false';
    // Judged in the offending version's own view, a proof that holds, or fails, always will.
    if (verdict === 'holds' || verdict === 'false') judgedWarrants.set(cacheKey, verdict);
    return verdict;
  }

  /** Warrants already judged: each checked once, not on every look at who is flagged */
  const judgedWarrants = new Map<string, WarrantVerdict>();

  /**
   * A warrant's body, if the version has a warrant's shape: a first version
   * of `std.warrant`, not a delete, and not against its writer. Anything else
   * flags nobody.
   */
  async function warrantShape(version: Version): Promise<Warrant | 'unnamed' | null> {
    if (version.deleted || version.seq !== 0 || version.collection !== WARRANT_COLLECTION) return null;
    const warrant = readWarrant((await openBody(version)).body);
    const offending = warrant?.evidence[0];
    if (!warrant || !offending || !(await judge(offending)).verified) return null;
    // The one answer that can change: the account may be named once more of the history arrives.
    const against = await accountable(offending);
    if (!against) return 'unnamed';
    const by = (await judge(version)).root;
    return by && against !== by ? warrant : null;
  }

  /** The proof a version gives against its account, or null when it gives none */
  async function violationIn(version: Version): Promise<{ kind: WarrantKind; evidence: Version[] } | null> {
    const root = await accountable(version);
    if (!root) return null;
    const previous = await previousOf(version);
    if (previous && chainProblem(version, previous))
      return { kind: 'chain', evidence: [stubOf(version), stubOf(previous)] };
    if (ACCESS_COLLECTIONS.has(version.collection)) {
      const event = await buildEvent(version);
      const quick = event && (await access()).history.at(event.seen);
      if (!event || (quick && !refusal(event, quick))) return null;
      return (await evidenceHolds('access', [version])) === 'holds'
        ? { kind: 'access', evidence: [version] }
        : null;
    }
    // A warrant is a record like any other: a false one flags nobody, and proves nothing against its writer.
    if (version.collection === WARRANT_COLLECTION) return null;
    // The global view first, which is cheap; the own view, a replay, only for what it finds broken.
    // Proof only the own view would show goes unwritten: a flag missed, never a false one.
    const quick = (await access()).history.at(version.seen ?? []);
    if (quick && (await standingBrokenIn(quick, version, root)) !== 'holds') return null;
    return (await standingBroken(version, root)) === 'holds'
      ? { kind: 'standing', evidence: [stubOf(version)] }
      : null;
  }

  /**
   * Writes down, as this account's own record, the proof a version gives
   * against its account — unless a warrant of its own against that account
   * stands already, so one account's misconduct costs each member one record
   * at a time. It doesn't lean on anyone else's warrant, which would go if
   * its writer were removed. One that can't write leaves it to one that can.
   */
  async function warrantIfDue(version: Version): Promise<void> {
    if (deps.isClosed() || (await cannotWrite())) return;
    // Only an account the history names can be warranted: anything else stops here, for free.
    const root = await accountable(version);
    if (!root || root === deps.rootDid) return;
    // With a warrant of its own against that account standing, its next offences cost nothing to look at.
    if ((await flagged()).some((flag) => flag.account === root && flag.by === deps.rootDid)) return;
    const violation = await violationIn(version);
    // Taken only once there is something to write, so a decoy can't hide an offence behind it.
    if (!violation || warranting.has(root)) return;
    warranting.add(root);
    try {
      if (!(await flagged()).some((flag) => flag.account === root && flag.by === deps.rootDid))
        await warrantOnce(violation);
    } finally {
      warranting.delete(root);
    }
  }

  /** Accounts this node is writing a warrant against now: offences that arrive meanwhile wait for the next */
  const warranting = new Set<string>();

  async function warrantOnce(violation: { kind: WarrantKind; evidence: Version[] }): Promise<void> {
    // Checked again: the space may have closed while the proof was being worked out.
    if (deps.isClosed()) return;
    await upsert(WARRANT_COLLECTION, await newRecordKey(deps.rootDid), violation);
  }

  /** The accounts proven to have broken the protocol's rules here, by the warrants that stand */
  async function flagged(): Promise<ReadonlyArray<FlaggedAccount>> {
    const found: FlaggedAccount[] = [];
    // Each warrant's first version, kept whole, whatever came after it: like any record, anyone
    // may write a later version or a delete, and neither takes the proof back.
    const firsts: Version[] = [];
    for (const current of await storage.queryVersions(WARRANT_COLLECTION))
      for (const version of await storage.history(current.key))
        if (version.seq === 0 && version.collection === WARRANT_COLLECTION) firsts.push(version);
    for (const version of firsts) {
      if (version.deleted || isStub(version) || !(await standingOf(version)).ok) continue;
      // Only proof this peer checked: one that stands unjudged, for want of rules it can't read, flags nobody.
      if ((await warrantVerdict(version)) !== 'holds') continue;
      const warrant = readWarrant((await openBody(version)).body);
      const offending = warrant?.evidence[0];
      const account = offending && (await accountable(offending));
      if (!warrant || !offending || !account || !knownKind(warrant.kind)) continue;
      const by = (await judge(version)).root ?? version.author;
      // One flag per offence and writer, however many records say it.
      if (found.some((flag) => flag.offence === offending.id && flag.by === by)) continue;
      found.push({ account, key: offending.author, kind: warrant.kind, by, offence: offending.id });
    }
    return found;
  }

  return { warrantIfDue, flagged };
}
