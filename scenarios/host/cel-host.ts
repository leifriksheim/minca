/**
 * The CEL side's host: what a peer does around Weave's CEL checks
 * (`packages/core/src/records/checks.ts`, `runChecks`), simplified from
 * `packages/core/src/node/space-runtime.ts` and spec 03:
 *
 * - a version counts only when the version before it does (the chain);
 * - it counts only when its author is a member as of what it had seen;
 * - it waits (pending) for anything it saw, follows or cites that isn't held;
 * - a cited version must count, and its author must still be a member as of
 *   what the citing version had seen;
 * - membership as of a version is replayed from `std.member` records in its
 *   past: an add counts when it passes, a removal too, and a removal holds
 *   until an add that had seen it.
 *
 * Optional host rules the examples need, which CEL can't express:
 * `lines` (the plan's line rule, §3) and `values` (more names for a check,
 * like `memberCount`).
 *
 * A first version at an owned key (`<owner>.<name>`, spec 02 §4.1) fails
 * unless its author owns the key, as every peer refuses one; and `creator`
 * is the author of the first version a version's own chain starts from, not
 * whichever first version at its key the host found. The scenarios' other
 * keys are labels (`m0`), which a peer would refuse, kept short for reading.
 *
 * A line is one account's sequence in a collection, at the account's line
 * key (`lineKey`, the library's derivation). Only that account's own
 * versions can be in it, or be twins:
 *
 * - a version in a line collection at any other key fails;
 * - two versions of a line after the same one (or two first versions) are
 *   a double spend, and neither counts, nor anything after either. There
 *   are no corrections in v1 (the plan, §3);
 * - each `once` field's citations appear at most once along the line, which
 *   is the counted chain;
 * - a declaration with a key the host doesn't know is not judged
 *   (`unjudged`), like a space with an unknown resolver.
 */
import { runChecks, type Check, type CheckedVersion } from '../../packages/core/src/records/checks.js';
import { keyKind, lineKey, ownsKey } from '../../packages/core/src/records/key.js';
import type { Version } from './space.js';
import { isRecord } from './ucan-policy.js';

/** `unjudged`: its collection declares something this peer doesn't know */
export type Verdict = 'pass' | 'fail' | 'pending' | 'unjudged';

/** The keys a line declaration may have; any other leaves the collection unjudged */
const LINE_KEYS: ReadonlyArray<string> = ['once'];

/** A line collection's declaration, as written: its keys are closed */
export interface Line {
  /** Fields whose citations appear once along the line */
  readonly once?: ReadonlyArray<string>;
  readonly [key: string]: unknown;
}

export interface Host {
  /** Who can never be removed */
  readonly founders: ReadonlyArray<string>;
  /** Members from the start, who can be removed */
  readonly members?: ReadonlyArray<string>;
  /** Contracts by collection */
  readonly contracts: Readonly<Record<string, ReadonlyArray<Check>>>;
  /** Line collections, and the fields whose citations appear once along a line */
  readonly lines?: Readonly<Record<string, Line>>;
  /** More names a check reads, given the members as of the version */
  readonly values?: (v: Version, members: ReadonlySet<string>) => Record<string, unknown>;
}

export interface Judged {
  verdict(id: string): Promise<Verdict>;
  /** Members as of what `id` had seen (not counting `id` itself) */
  membersAsOf(id: string): Promise<ReadonlySet<string> | null>;
}

/** Judges a set of held versions. Verdicts are cached, so build a new one when more arrive. */
export function judge(held: Iterable<Version>, host: Host): Judged {
  const byId = new Map<string, Version>();
  for (const v of held) byId.set(v.id, v);
  const verdicts = new Map<string, Promise<Verdict>>();
  const memberSets = new Map<string, Promise<ReadonlySet<string> | null>>();

  /** Everything `v` had seen, through what that had seen; null when some is not held */
  const pastOf = (v: Version): Set<string> | null => {
    const past = new Set<string>();
    const queue = [...v.seen];
    while (queue.length > 0) {
      const id = queue.pop() ?? '';
      if (past.has(id)) continue;
      const w = byId.get(id);
      if (!w) return null;
      past.add(id);
      queue.push(...w.seen);
    }
    return past;
  };

  const membersAsOf = (id: string): Promise<ReadonlySet<string> | null> => {
    let p = memberSets.get(id);
    if (!p) memberSets.set(id, (p = replay(id)));
    return p;
  };

  async function replay(id: string): Promise<ReadonlySet<string> | null> {
    const v = byId.get(id);
    const past = v ? pastOf(v) : null;
    if (!past) return null;
    const changes: Version[] = [];
    for (const pid of [...past].sort()) {
      const w = byId.get(pid);
      if (w?.collection === 'std.member' && (await verdict(pid)) === 'pass') changes.push(w);
    }
    const out = new Set([...host.founders, ...(host.members ?? [])]);
    const didOf = (w: Version) => field(w, 'did');
    for (const w of changes) if (field(w, 'op') === 'add') out.add(didOf(w));
    for (const r of changes) {
      if (field(r, 'op') !== 'remove' || host.founders.includes(didOf(r))) continue;
      const readded = changes.some(
        (a) => field(a, 'op') === 'add' && didOf(a) === didOf(r) && pastOf(a)?.has(r.id),
      );
      if (!readded) out.delete(didOf(r));
    }
    return out;
  }

  const verdict = (id: string): Promise<Verdict> => {
    let p = verdicts.get(id);
    if (!p) verdicts.set(id, (p = judgeOne(id)));
    return p;
  };

  async function judgeOne(id: string): Promise<Verdict> {
    const v = byId.get(id);
    if (!v) return 'pending';
    if (v.prev) {
      const before = await verdict(v.prev);
      if (before !== 'pass') return before;
    }
    // Whose key it is: nobody else may write its first version.
    if (v.seq === 0 && keyKind(v.key) === 'owned' && !(await ownsKey(v.key, v.author))) return 'fail';
    const line = host.lines?.[v.collection];
    if (line) {
      // A declaration with a key this peer doesn't know is not judged, like an unknown resolver.
      if (Object.keys(line).some((k) => !LINE_KEYS.includes(k))) return 'unjudged';
      if (v.key !== (await lineKey(v.author, v.collection))) return 'fail';
      const prev = v.prev ? byId.get(v.prev) : undefined;
      if (prev && (prev.author !== v.author || prev.key !== v.key)) return 'fail';
      // Two versions of the line after the same one: a double spend, and neither counts.
      const twin = [...byId.values()].some(
        (w) => w.id !== v.id && w.key === v.key && w.author === v.author && w.prev === v.prev,
      );
      if (twin) return 'fail';
      if (!onceAlong(v, line.once ?? [])) return 'fail';
    }
    const members = await membersAsOf(id);
    if (!members) return 'pending';
    if (!members.has(v.author)) return 'fail';
    const checks = host.contracts[v.collection];
    if (!checks) return 'pass';
    const prev = v.prev ? byId.get(v.prev) : undefined;
    // The first version this one's own chain starts from.
    let first: Version | undefined = v;
    while (first?.prev) first = byId.get(first.prev);
    const outcome = await runChecks(checks, {
      values: {
        body: v.body,
        links: v.links,
        key: v.key,
        seq: v.seq,
        collection: v.collection,
        author: v.author,
        creator: first?.author ?? v.author,
        createdAt: '',
        prev: prev ? checked(prev) : null,
        ...host.values?.(v, members),
      },
      cite: async (cid) => {
        const w = byId.get(cid);
        if (!w) return { later: true };
        const fares = await verdict(cid);
        if (fares === 'pending') return { later: true };
        if (fares !== 'pass') return { refused: 'it does not count' };
        if (!members.has(w.author)) return { refused: 'its author was removed' };
        return checked(w);
      },
      member: (did) => members.has(did),
    });
    if ('later' in outcome) return 'pending';
    if ('unreadable' in outcome) return 'fail';
    return outcome.passed ? 'pass' : 'fail';
  }

  /** Whether each citation in `fields` appears once along `v`'s line, `v` included */
  function onceAlong(v: Version, fields: ReadonlyArray<string>): boolean {
    const seen = new Set<string>();
    for (let w: Version | undefined = v; w; w = w.prev ? byId.get(w.prev) : undefined) {
      for (const f of fields) {
        const cites = isRecord(w.body) ? w.body[f] : undefined;
        for (const c of Array.isArray(cites) ? cites : []) {
          const key = `${f} ${JSON.stringify(c)}`;
          if (seen.has(key)) return false;
          seen.add(key);
        }
      }
    }
    return true;
  }

  return { verdict, membersAsOf };
}

function checked(v: Version): CheckedVersion {
  return {
    id: v.id,
    key: v.key,
    collection: v.collection,
    seq: v.seq,
    author: v.author,
    createdAt: '',
    deleted: v.deleted,
    body: v.body,
    links: v.links,
  };
}

function field(v: Version, name: string): string {
  const b = v.body;
  if (!isRecord(b)) return '';
  const x = b[name];
  return typeof x === 'string' ? x : '';
}
