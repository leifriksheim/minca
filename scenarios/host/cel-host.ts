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
 * A line is one account's sequence in a collection, at a key derived from
 * the account (`lineKey`), a stand-in for #72's keys that belong to their
 * creator. Only that account's own versions can be in it, or be twins:
 *
 * - a version in a line collection at any other key fails;
 * - two versions of a line after the same one (or two first versions) are
 *   a double spend, and neither counts, nor anything after either;
 * - except a correction: a version that had seen its twin, where the twin
 *   failed only because of something it cited (it would pass if what it
 *   cited stood). The payee who built on a double spend writes it after
 *   their last counted version and carries on;
 * - a correction restates the failed version, and the versions after it
 *   restate the failed ones after that, in order: the same `restate`
 *   fields, and the same `once` citations less those that fail. Past the
 *   end of the failed chain, the line is free again;
 * - each `once` field's citations appear at most once along the line, which
 *   is the counted chain: a failed version's citations don't count.
 */
import { runChecks, type Check, type CheckedVersion } from '../../packages/core/src/records/checks.js';
import type { Version } from './space.js';
import { isRecord } from './ucan-policy.js';

export type Verdict = 'pass' | 'fail' | 'pending';

/** A line collection's declaration */
export interface Line {
  /** Fields whose citations appear once along the line */
  readonly once: ReadonlyArray<string>;
  /** Fields a correction, and what follows it, carry unchanged from the failed versions they restate */
  readonly restate?: ReadonlyArray<string>;
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

/** The one key of `did`'s line in `collection` */
export const lineKey = (collection: string, did: string) => `${collection}/${did}`;

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

  /** A version's verdict before the twin rule, and whether it fails only for what it cites */
  const owns = new Map<string, Promise<{ verdict: Verdict; forCitation: boolean }>>();
  const own = (id: string) => {
    let p = owns.get(id);
    if (!p) owns.set(id, (p = judgeOwn(id)));
    return p;
  };

  async function judgeOne(id: string): Promise<Verdict> {
    const v = byId.get(id);
    if (!v) return 'pending';
    const mine = await own(id);
    const line = host.lines?.[v.collection];
    if (mine.verdict !== 'pass' || !line) return mine.verdict;
    for (const w of twins(v)) {
      // v counts beside a twin only when v corrects it: v had seen it, and it fails only for what it cites.
      const corrects = pastOf(v)?.has(w.id) ?? false;
      const theirs = corrects ? await own(w.id) : null;
      if (theirs?.verdict === 'pending') return 'pending';
      if (!theirs?.forCitation) return 'fail';
    }
    const owed = await restating(v);
    if (owed === 'pending') return 'pending';
    if (owed === 'fork') return 'fail';
    return owed ? restates(v, owed, line) : 'pass';
  }

  /** The other versions of `v`'s line after the same one */
  const twins = (v: Version) =>
    [...byId.values()].filter(
      (w) => w.id !== v.id && w.key === v.key && w.author === v.author && w.prev === v.prev,
    );

  /** The failed version `v` must restate: its twin if it corrects one, else the one after what its previous restated */
  async function restating(v: Version): Promise<Version | null | 'pending' | 'fork'> {
    for (const w of twins(v)) {
      if (!(pastOf(v)?.has(w.id) ?? false)) continue;
      const theirs = await own(w.id);
      if (theirs.verdict === 'pending') return 'pending';
      if (theirs.forCitation) return w;
    }
    const prev = v.prev ? byId.get(v.prev) : undefined;
    if (!prev) return null;
    const owed = await restating(prev);
    if (owed === null || typeof owed === 'string') return owed;
    const after = [...byId.values()].filter(
      (r) => r.key === owed.key && r.author === owed.author && r.prev === owed.id,
    );
    // A fork inside the failed chain is the writer's own double spend: nothing restates it.
    if (after.length > 1) return 'fork';
    return after[0] ?? null;
  }

  /** Whether `v` carries `r`'s payment unchanged, less the citations that fail */
  async function restates(v: Version, r: Version, line: Line): Promise<Verdict> {
    const field = (x: Version, f: string) => (isRecord(x.body) ? (x.body[f] ?? null) : null);
    for (const f of line.restate ?? [])
      if (JSON.stringify(field(v, f)) !== JSON.stringify(field(r, f))) return 'fail';
    for (const f of line.once) {
      const was = field(r, f);
      const kept: unknown[] = [];
      for (const c of Array.isArray(was) ? was : []) {
        const fares = typeof c === 'string' ? await verdict(c) : 'fail';
        if (fares === 'pending') return 'pending';
        if (fares !== 'fail') kept.push(c);
      }
      if (JSON.stringify(field(v, f) ?? []) !== JSON.stringify(kept)) return 'fail';
    }
    return 'pass';
  }

  async function judgeOwn(id: string): Promise<{ verdict: Verdict; forCitation: boolean }> {
    const only = (verdict: Verdict) => ({ verdict, forCitation: false });
    const v = byId.get(id);
    if (!v) return only('pending');
    if (v.prev) {
      const before = await verdict(v.prev);
      if (before !== 'pass') return only(before);
    }
    const line = host.lines?.[v.collection];
    if (line) {
      if (v.key !== lineKey(v.collection, v.author)) return only('fail');
      const prev = v.prev ? byId.get(v.prev) : undefined;
      if (prev && (prev.author !== v.author || prev.key !== v.key)) return only('fail');
      if (!onceAlong(v, line.once)) return only('fail');
    }
    const members = await membersAsOf(id);
    if (!members) return only('pending');
    if (!members.has(v.author)) return only('fail');
    const checks = host.contracts[v.collection];
    if (!checks) return only('pass');
    const prev = v.prev ? byId.get(v.prev) : undefined;
    const first = [...byId.values()].find((w) => w.key === v.key && w.seq === 0);
    const run = (excuse: boolean) =>
      runChecks(checks, {
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
          // With `excuse`, what it cites is taken as standing: would it pass but for that?
          if (excuse) return checked(w);
          if (fares === 'fail') return { refused: 'it does not count' };
          if (!members.has(w.author)) return { refused: 'its author was removed' };
          return checked(w);
        },
        can: () => false,
        member: (did) => members.has(did),
      });
    const outcome = await run(false);
    if ('later' in outcome) return only('pending');
    if ('unreadable' in outcome) return only('fail');
    if (outcome.passed) return only('pass');
    const excused = await run(true);
    return { verdict: 'fail', forCitation: 'passed' in excused && excused.passed };
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
