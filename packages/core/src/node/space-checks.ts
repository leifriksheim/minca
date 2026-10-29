/**
 * @module node/space-checks
 * Conditions a collection's versions must meet (`records/contracts.ts`),
 * and the lines its writers keep (spec 09). The library reads them; peers
 * don't enforce them. They read only what never changes: this version, the
 * one before when it was kept whole, and versions cited by id, kept whole
 * and standing.
 */
import { cached, getOrAdd, setCapped } from '../utils/map.js';
import type { Link, Version } from '../types.js';
import { isStub } from '../schema/version.js';
import { lineKey } from '../records/key.js';
import {
  checkContractShape,
  checkContracts,
  checkLine,
  hasContract,
  onceCitations,
  runContracts,
  type Contract,
  type CitedVersion,
  type Line,
  type Uncited,
} from '../records/contracts.js';
import { ACCESS_COLLECTIONS, isMember, type AccessState } from '../space/roles.js';
import { isRecord } from '../utils/guards.js';
import {
  type Versions,
  type Standing,
  type ChecksVerdict,
  copyKey,
  idsKey,
  STANDS,
  NO_CHECKS,
  UNJUDGED,
  type SpaceBase,
} from './space-versions.js';
import type { History } from './space-history.js';
import type { Rules } from './space-rules.js';
import type { StandingJudge } from './space-standing.js';

export function createChecks({
  storage,
  versions,
  history,
  rules,
  standing,
}: SpaceBase & {
  readonly versions: Versions;
  readonly history: History;
  readonly rules: Rules;
  readonly standing: StandingJudge;
}) {
  const { judge, openBody, unreadable, namedFirst, consistent, previousOf } = versions;
  const { access } = history;
  const { rulesAt } = rules;
  const { standingOf } = standing;

  /** Line heads whose `once` claims are kept: each set holds its whole chain's, so fewer */
  const MAX_ONCE_CLAIMED = 1024;
  /** Records waiting on a cited version that are read again whenever anything arrives */
  const MAX_PENDING_REREAD = 256;
  const isLine = (line: unknown): line is Line => checkLine(line) === null;
  /** Checks verdicts, by version and the view it was judged in */
  const checkVerdicts = new Map<string, Promise<ChecksVerdict>>();
  /** Records whose newest version waits on a version it cites: read again when anything arrives */
  const pendingKeys = new Set<string>();

  /** A version as a check reads it: its author's account, and its content when it was kept whole */
  async function checkedVersion(
    version: Version,
    whole: boolean,
  ): Promise<CitedVersion | { readonly unreadable: true }> {
    let body: unknown = null;
    // Public links are on the outside, the same for every peer; sealed ones only with the body.
    let links: ReadonlyArray<Link> = version.links ?? [];
    if (whole && !version.deleted) {
      const opened = await openBody(version);
      if (unreadable(opened)) return { unreadable: true };
      body = opened.body;
      links = opened.links;
    }
    return Object.freeze({
      id: version.id,
      key: version.key,
      collection: version.collection,
      seq: version.seq,
      author: (await judge(version)).root ?? version.author,
      createdAt: version.createdAt,
      deleted: !!version.deleted,
      body,
      links,
    });
  }

  /** A version a check cites: here, kept whole, and standing — or why it can't count */
  async function cited(id: string, within: ReadonlyArray<string>): Promise<CitedVersion | Uncited> {
    const version = await storage.getVersion(id);
    if (!version) return { later: true };
    // Whether it was kept is on the version, signed: the same answer on every peer.
    if (!version.retain && !version.deleted) return { refused: `it cites ${id}, which was not kept whole` };
    if (!(await consistent(version))) return { refused: `it cites ${id}, which is not its record's` };
    // As of what the citing version saw: a removal after it doesn't undo it.
    const stands = await standingOf(version, within);
    if (!stands.ok)
      return stands.later ? { later: true } : { refused: `it cites ${id}, which does not stand` };
    // Its own checks too, as of what the citing version saw.
    const passes = await checksOf(version, within);
    if ('pending' in passes) return { later: true };
    if (passes.passes === false) return { refused: `it cites ${id}, which fails its checks` };
    if (passes === UNJUDGED) return { unreadable: true };
    if ('unjudged' in passes) return { unjudged: true };
    return checkedVersion(version, true);
  }

  /**
   * Whether a version passes its collection's checks: the library reads them,
   * peers don’t enforce them (spec/09-contracts.md). `passes: null`
   * when there are none, or this node can't read what they need; `pending`
   * while a version it cites hasn't arrived. Judged as of what it saw, or, for
   * a version another cites, as of what that one saw (`within`).
   */
  async function checksOf(version: Version, within?: ReadonlyArray<string>): Promise<ChecksVerdict> {
    if (ACCESS_COLLECTIONS.has(version.collection) || version.collection.startsWith('sys.')) return NO_CHECKS;
    const cacheKey = `${copyKey(version)}|${within ? idsKey(within) : ''}`;
    // Only what can't change is kept: not a verdict waiting on what it cites, nor one this node couldn't judge.
    const settled = (found: ChecksVerdict) => !('pending' in found) && found !== UNJUDGED;
    return cached(checkVerdicts, cacheKey, () => judgeChecks(version, within), settled);
  }

  async function judgeChecks(version: Version, within?: ReadonlyArray<string>): Promise<ChecksVerdict> {
    const first = await namedFirst(version);
    const root = (await judge(version)).root;
    if (!first || !root) return NO_CHECKS;
    const state = (await access()).history.at(version.seen ?? [], within);
    if (!state) return { pending: true };
    const defined = await rulesAt(state, version.collection);
    const contract = defined?.contract;
    if (contract === undefined) return NO_CHECKS;
    // A contract with a key this library doesn't know: not judged, as a line's below.
    const shape = checkContractShape(contract);
    if (shape === 'unknown')
      return { passes: null, unjudged: `${version.collection} has a contract this library doesn't know` };
    if (shape !== null || !isRecord(contract))
      return { passes: false, reason: `The contract of ${version.collection} can't be read` };
    const listed: unknown = contract.check;
    const checks: unknown = Array.isArray(listed) && listed.length === 0 ? undefined : listed;
    const line: unknown = contract.line;
    if (checks === undefined && line === undefined) return NO_CHECKS;
    // Peers keep any list; one its author's node would have refused can't be read, so nothing passes it.
    if (checks !== undefined && (checkContracts(checks, 'contract.check') !== null || !Array.isArray(checks)))
      return { passes: false, reason: `The contract of ${version.collection} can't be read` };
    // A line declaration with a key this library doesn't know: not judged, as a space with an unknown resolver.
    const lineProblem = line === undefined ? null : checkLine(line);
    if (lineProblem === 'unknown')
      return { passes: null, unjudged: `${version.collection} declares a line this library doesn't know` };
    if (lineProblem !== null)
      return { passes: false, reason: `The line of ${version.collection} can't be read` };
    if (line !== undefined) lineCollections.add(version.collection);
    // What this node can't open, it can't judge: unjudged, so not counted, until it can (spec 09 §2).
    if (!version.deleted) {
      const opened = await openBody(version);
      if (unreadable(opened)) return UNJUDGED;
    }
    // It continues the version before: one that follows a version failing its checks fails too,
    // or a forged step would be laundered by the next.
    let previous = await previousOf(version);
    if (version.seq > 0 && version.prev && !previous) return { pending: true };
    // In a line, a delete is a step that ends it for good: nothing after it counts (spec 09 §7.5).
    if (line !== undefined && previous?.deleted)
      return { passes: false, reason: 'It follows a delete, which ends its line' };
    // A delete in between hides nothing: the chain is judged by the step before it.
    while (previous?.deleted && previous.seq > 0 && previous.prev) {
      const before: Version | null = await storage.getVersion(previous.prev);
      if (!before) return { pending: true };
      previous = before;
    }
    // A step under checks is kept whole by an honest writer (it is signed, so every reader sees the same):
    // one that wasn't can't be judged, and what follows it doesn't count.
    if (previous && !previous.retain && !previous.deleted) {
      const then = (await access()).history.at(previous.seen ?? []);
      const before = then ? await rulesAt(then, previous.collection) : null;
      if (hasContract(before?.contract))
        return { passes: false, reason: 'It follows a version under a contract that was not kept whole' };
    }
    if (previous && !isStub(previous)) {
      if (previous.retain && !previous.deleted) {
        const before = await openBody(previous);
        if (unreadable(before)) return UNJUDGED;
      }
      if (!(await standingOf(previous)).ok)
        return { passes: false, reason: 'It follows a version that does not stand' };
      const before = await checksOf(previous);
      if ('pending' in before) return { pending: true };
      // A step this node couldn't judge leaves what follows unjudged too, so neither is kept as a pass.
      if (before === UNJUDGED) return UNJUDGED;
      if ('unjudged' in before) return before;
      if (before.passes === false)
        return { passes: false, reason: `It follows a version that fails its checks: ${before.reason}` };
    }
    // A delete has no content to check, but it continues the chain like any step: one that follows a
    // failing step fails too, so it can't hide the record from readers or make its key unwritable.
    if (line !== undefined) {
      const broken = await lineBreak(version, root, isLine(line) ? (line.once ?? []) : []);
      if (broken === UNJUDGED) return UNJUDGED;
      if (typeof broken === 'string') return { passes: false, reason: broken };
    }
    if (version.deleted || checks === undefined || !Array.isArray(checks)) return NO_CHECKS;
    const outcome = await checkStanding(version, first, root, state, checks);
    if (outcome === 'unreadable') return UNJUDGED;
    if (outcome === 'unjudged')
      return { passes: null, unjudged: 'It cites a version in a collection this library doesn’t judge' };
    if (outcome.ok) return { passes: true };
    return outcome.later ? { pending: true } : { passes: false, reason: outcome.reason };
  }

  /** Whether a version counts for this node's reader: it stands, and passes its contract */
  async function counts(version: Version): Promise<boolean> {
    if (!(await standingOf(version)).ok) return false;
    const passes = await checksOf(version);
    // Bounded: past it, a waiting record is read again only when the index is rebuilt.
    if ('pending' in passes && pendingKeys.size < MAX_PENDING_REREAD) pendingKeys.add(version.key);
    return !('pending' in passes) && !('unjudged' in passes) && passes.passes !== false;
  }

  /** Collections this node has judged as lines: a version arriving in one can undo a verdict (a double spend) */
  const lineCollections = new Set<string>();
  /**
   * Every version held in a line collection, by key and the version it
   * names before it: deletes and stubs included, whatever `retain` says, so
   * no twin hides from the double-spend check. Dropped when one arrives.
   */
  const lineIndexes = new Map<string, Promise<Map<string, Version[]>>>();
  const twinKey = (version: Version) => `${version.key}\n${version.prev ?? ''}`;
  function lineIndex(collection: string): Promise<Map<string, Version[]>> {
    return cached(lineIndexes, collection, async () => {
      const byPlace = new Map<string, Version[]>();
      for (const version of await storage.keptVersions(collection)) {
        getOrAdd(byPlace, twinKey(version), () => []).push(version);
      }
      return byPlace;
    });
  }

  /**
   * Why a version breaks its line's rule (spec 09 §6), or null. Its key is its
   * author's line key; no other version at that key names the same version
   * before it (a double spend: neither counts, nor anything after either);
   * and no citation in a `once` field appears twice along the counted chain,
   * this version and every one before it.
   */
  async function lineBreak(
    version: Version,
    root: string,
    once: ReadonlyArray<string>,
  ): Promise<string | null | typeof UNJUDGED> {
    if (version.key !== (await lineKey(root, version.collection)))
      return 'It is not at its author’s line key';
    for (const other of (await lineIndex(version.collection)).get(twinKey(version)) ?? []) {
      if (other.id === version.id || other.seq !== version.seq) continue;
      // At an owned key only its owner's versions stand; one that doesn't is no twin.
      if ((await judge(other)).root !== root) continue;
      return 'A double spend: another version of this line follows the same one';
    }
    if (once.length === 0 || version.deleted) return null;
    // Back to the nearest step whose claims are known, then forward: judging a line is linear.
    const fields = JSON.stringify(once);
    const path: Version[] = [];
    let known: ReadonlySet<string> | undefined;
    for (let step: Version | null = version; step;) {
      known = onceClaimed.get(`${step.id}|${fields}`);
      if (known) break;
      path.push(step);
      step = await previousOf(step);
    }
    const claimed = new Set(known);
    // A stub's claims can't be read yet, so a walk through one isn't kept: the whole version may arrive.
    let throughStub = false;
    for (const step of path.reverse()) {
      if (step.deleted) continue;
      if (isStub(step)) throughStub = true;
      const opened = await openBody(step);
      if (unreadable(opened)) return UNJUDGED;
      for (const citation of onceCitations(opened.body, once)) {
        if (claimed.has(citation)) return 'It claims something its line has already claimed';
        claimed.add(citation);
      }
    }
    // An id names its content, and so its whole chain: what it claimed never changes.
    if (throughStub) return null;
    setCapped(onceClaimed, `${version.id}|${fields}`, claimed, MAX_ONCE_CLAIMED);
    return null;
  }
  /** What a line's `once` fields claimed along the chain ending at a version, by its id and the fields */
  const onceClaimed = new Map<string, ReadonlySet<string>>();

  async function checkStanding(
    version: Version,
    first: Version,
    root: string,
    state: AccessState,
    checks: ReadonlyArray<Contract>,
  ): Promise<Standing | 'unjudged' | 'unreadable'> {
    const opened = await openBody(version);
    // Without the key, a peer can't tell: unjudged, as for a cited version it can't open.
    if (unreadable(opened)) return 'unreadable';
    const previous = await previousOf(version);
    const prev = previous ? await checkedVersion(previous, !!previous.retain) : null;
    if (prev && 'unreadable' in prev) return 'unreadable';
    const outcome = await runContracts(checks, {
      values: {
        body: opened.body,
        links: opened.links,
        key: version.key,
        seq: version.seq,
        collection: version.collection,
        author: root,
        creator: (await judge(first)).root ?? first.author,
        createdAt: version.createdAt,
        prev,
      },
      cite: (id) => cited(id, version.seen ?? []),
      member: (did) => isMember(state, did),
    });
    if ('later' in outcome)
      return { ok: false, reason: 'Versions it cites have not arrived yet', later: true };
    if ('unjudged' in outcome) return 'unjudged';
    if ('unreadable' in outcome) return 'unreadable';
    if (outcome.passed) return STANDS;
    return { ok: false, reason: outcome.reason };
  }

  return {
    checksOf,
    counts,
    /** Records waiting on a version they cite, to be read again now that something arrived */
    takeWaiting(): ReadonlyArray<string> {
      const keys = [...pendingKeys];
      pendingKeys.clear();
      return keys;
    },
    /**
     * Versions arrived. True when one is in a line: it can make a double
     * spend of one that counted, and undo what cites it.
     */
    arrived(placed: ReadonlyArray<Version>): boolean {
      if (!placed.some((version) => lineCollections.has(version.collection))) return false;
      checkVerdicts.clear();
      for (const version of placed) lineIndexes.delete(version.collection);
      return true;
    },
    /** Verdicts that rest on the access history or the definitions, which changed */
    forget(): void {
      checkVerdicts.clear();
      lineIndexes.clear();
    },
  };
}

export type Checks = ReturnType<typeof createChecks>;
