/**
 * A stand-in host for SQL contracts: what a peer does around them, as
 * `scenarios/host/cel-host.ts` does for CEL (chains, pending, standing as of
 * `seen`, membership replayed from `std.member`), plus the line rule of
 * spec 09 §7, either built in or left to the contract.
 *
 * What a contract sees is a fresh database of fixed tables (`SCHEMA`), filled
 * from the judged version, the one before it, and the versions it cites. SQL
 * can't call back into the host mid-query, so what a version cites is
 * declared: `cites` names body fields holding an id or a list of ids, and the
 * host resolves them all before the query runs.
 */
import { keyKind, lineKey, ownsKey } from '../../packages/core/src/records/key.js';
import type { Version } from '../host/space.js';
import { isRecord } from '../host/ucan-policy.js';
import type { Engine, Table } from './engine.js';

export type Verdict = 'pass' | 'fail' | 'pending';

export interface SqlContract {
  /** One `SELECT` giving one row of one column: 1 passes */
  readonly that: string;
  readonly else: string;
}

export interface SqlCollection {
  readonly check?: ReadonlyArray<SqlContract>;
  /** Body fields whose values (an id, or a list of ids) are cited */
  readonly cites?: ReadonlyArray<string>;
  /** A line, judged by the host as the library does (spec 09 §7) */
  readonly line?: { readonly once: ReadonlyArray<string> };
  /**
   * A line judged by SQL alone, in place of `line`: the host only fills the
   * `line` table and `this.line_key`, and runs these on every version,
   * deletes included, before `check`.
   */
  readonly lineCheck?: ReadonlyArray<SqlContract>;
}

export interface SqlHost {
  readonly founders: ReadonlyArray<string>;
  readonly members?: ReadonlyArray<string>;
  readonly collections: Readonly<Record<string, SqlCollection>>;
}

const VERSION_COLUMNS = ['id', 'collection', 'key', 'seq', 'author', 'deleted', 'prev', 'body'] as const;

/** What a contract reads. Bodies and links are JSON text; `link` and `members` are tables too. */
export const SCHEMA = {
  this: [...VERSION_COLUMNS, 'creator', 'line_key'],
  prev: VERSION_COLUMNS,
  cited: ['field', 'ord', ...VERSION_COLUMNS],
  link: ['id', 'ord', 'rel', 'target'],
  line: VERSION_COLUMNS,
  members: ['did'],
} as const;

export interface SqlJudged {
  verdict(id: string): Promise<Verdict>;
}

export function judgeSql(held: Iterable<Version>, host: SqlHost, engine: Engine): SqlJudged {
  const byId = new Map<string, Version>();
  for (const v of held) byId.set(v.id, v);
  const verdicts = new Map<string, Promise<Verdict>>();
  const memberSets = new Map<string, Promise<ReadonlySet<string> | null>>();

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
    for (const w of changes) if (field(w, 'op') === 'add') out.add(field(w, 'did'));
    for (const r of changes) {
      if (field(r, 'op') !== 'remove' || host.founders.includes(field(r, 'did'))) continue;
      const readded = changes.some(
        (a) => field(a, 'op') === 'add' && field(a, 'did') === field(r, 'did') && pastOf(a)?.has(r.id),
      );
      if (!readded) out.delete(field(r, 'did'));
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
      if (byId.get(v.prev)?.deleted && host.collections[v.collection]?.line) return 'fail';
    }
    // Only an owned key's account writes there (02 §4.1).
    if (keyKind(v.key) === 'owned' && !(await ownsKey(v.key, v.author))) return 'fail';
    const members = await membersAsOf(id);
    if (!members) return 'pending';
    if (!members.has(v.author)) return 'fail';
    const def = host.collections[v.collection];
    if (!def) return 'pass';
    if (def.line && !(await builtInLine(v, def.line.once))) return 'fail';
    // A delete has no content to judge, except by a line written in SQL.
    if (v.deleted && !def.lineCheck) return 'pass';

    // The versions it cites, each resolved before the query runs (spec 09 §6.2).
    const cited: Array<{ field: string; ord: number; v: Version }> = [];
    for (const f of def.cites ?? []) {
      const ids = idsIn(v, f);
      for (const [ord, cid] of ids.entries()) {
        const w = byId.get(cid);
        if (!w) return 'pending';
        const fares = await verdict(cid);
        if (fares !== 'pass') return fares;
        if (!members.has(w.author)) return 'fail';
        cited.push({ field: f, ord, v: w });
      }
    }
    if (cited.length > 256) return 'fail';

    let first: Version | undefined = v;
    while (first?.prev) first = byId.get(first.prev);
    const prev = v.prev ? byId.get(v.prev) : undefined;
    const lineRows = def.lineCheck
      ? [...byId.values()].filter(
          (w) => w.key === v.key && w.collection === v.collection && w.author === v.author,
        )
      : [];
    const tables: Record<string, Table> = {
      this: {
        columns: SCHEMA.this,
        rows: [[...row(v), first?.author ?? v.author, await lineKey(v.author, v.collection)]],
      },
      prev: { columns: SCHEMA.prev, rows: prev ? [row(prev)] : [] },
      cited: { columns: SCHEMA.cited, rows: cited.map((c) => [c.field, c.ord, ...row(c.v)]) },
      link: {
        columns: SCHEMA.link,
        rows: [v, ...(prev ? [prev] : []), ...cited.map((c) => c.v)].flatMap((w) =>
          w.links.map((l, i) => [w.id, i, l.rel, l.to]),
        ),
      },
      line: { columns: SCHEMA.line, rows: lineRows.map(row) },
      members: { columns: SCHEMA.members, rows: [...members].map((m) => [m]) },
    };
    const conditions = [...(def.lineCheck ?? []), ...(v.deleted ? [] : (def.check ?? []))];
    const out = engine.evaluate(
      conditions.map((c) => c.that),
      tables,
    );
    return 'passed' in out && out.passed ? 'pass' : 'fail';
  }

  /** Spec 09 §7, as the library judges it */
  async function builtInLine(v: Version, once: ReadonlyArray<string>): Promise<boolean> {
    if (v.key !== (await lineKey(v.author, v.collection))) return false;
    for (const w of byId.values())
      if (
        w.id !== v.id &&
        w.key === v.key &&
        w.collection === v.collection &&
        w.author === v.author &&
        w.prev === v.prev
      )
        return false;
    for (const f of once) {
      const seenIds = new Set<string>();
      for (let w: Version | undefined = v; w; w = w.prev ? byId.get(w.prev) : undefined)
        for (const c of idsIn(w, f)) {
          if (seenIds.has(c)) return false;
          seenIds.add(c);
        }
    }
    return true;
  }

  return { verdict };
}

function row(v: Version): Array<string | number | null> {
  return [v.id, v.collection, v.key, v.seq, v.author, v.deleted ? 1 : 0, v.prev, JSON.stringify(v.body)];
}

function idsIn(v: Version, name: string): string[] {
  if (!isRecord(v.body)) return [];
  const x = v.body[name];
  if (typeof x === 'string') return [x];
  return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [];
}

function field(v: Version, name: string): string {
  const b = v.body;
  if (!isRecord(b)) return '';
  const x = b[name];
  return typeof x === 'string' ? x : '';
}
