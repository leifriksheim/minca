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
 * `forkKills` (a second version after the same one counts for neither) and
 * `values` (more names for a check, like `memberCount`).
 */
import { runChecks, type Check, type CheckedVersion } from '../../packages/core/src/records/checks.js';
import type { Version } from './space.js';
import { isRecord } from './ucan-policy.js';

export type Verdict = 'pass' | 'fail' | 'pending';

export interface Host {
  /** Who can never be removed */
  readonly founders: ReadonlyArray<string>;
  /** Members from the start, who can be removed */
  readonly members?: ReadonlyArray<string>;
  /** Contracts by collection */
  readonly contracts: Readonly<Record<string, ReadonlyArray<Check>>>;
  /** Collections where two versions after the same one both fail */
  readonly forkKills?: ReadonlyArray<string>;
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
    if (host.forkKills?.includes(v.collection)) {
      const twin = [...byId.values()].some((w) => w.id !== v.id && w.key === v.key && w.prev === v.prev);
      if (twin) return 'fail';
    }
    const members = await membersAsOf(id);
    if (!members) return 'pending';
    if (!members.has(v.author)) return 'fail';
    const checks = host.contracts[v.collection];
    if (!checks) return 'pass';
    const prev = v.prev ? byId.get(v.prev) : undefined;
    const first = [...byId.values()].find((w) => w.key === v.key && w.seq === 0);
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
        if (fares === 'fail') return { refused: 'it does not count' };
        if (!members.has(w.author)) return { refused: 'its author was removed' };
        return checked(w);
      },
      can: () => false,
      member: (did) => members.has(did),
    });
    if ('later' in outcome) return 'pending';
    if ('unreadable' in outcome) return 'fail';
    return outcome.passed ? 'pass' : 'fail';
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
