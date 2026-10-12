/**
 * Weave records as both sides see them: a space's held versions, and the
 * Datalog facts they become. Simplified from spec 02: no signatures, keys
 * or sealing; `seen` names versions directly; a version's id is a label.
 */
import { fact, type Fact, type Term } from './datalog.js';
import type { Json } from './ucan-policy.js';

export interface Link {
  readonly rel: string;
  readonly to: string;
}

export interface Version {
  readonly id: string;
  readonly key: string;
  readonly collection: string;
  readonly seq: number;
  /** The account (root DID), whichever of its devices signed */
  readonly author: string;
  /** Which of the account's devices signed: neither side reads it */
  readonly device?: string;
  readonly deleted: boolean;
  readonly body: Json;
  readonly links: ReadonlyArray<Link>;
  /** The version before it in this record, by id */
  readonly prev: string | null;
  /** Versions its writer had seen, by id */
  readonly seen: ReadonlyArray<string>;
}

/** A version, with defaults: a first version, seen nothing, key = id */
export const version = (v: Partial<Version> & Pick<Version, 'id' | 'collection' | 'author'>): Version =>
  Object.freeze({ key: v.id, seq: 0, deleted: false, body: {}, links: [], prev: null, seen: [], ...v });

/** The next version of `before`: a delete when `body` is null */
export const next = (before: Version, v: Partial<Version> & Pick<Version, 'id'>): Version =>
  version({
    ...before,
    seq: before.seq + 1,
    prev: before.id,
    seen: [before.id],
    deleted: v.body === null,
    body: v.body === null ? null : before.body,
    links: v.body === null ? [] : before.links,
    ...v,
  });

/**
 * Versions as Datalog facts, the same for every reader:
 *
 * - `record(Id, Collection, Author)`, `key(Id, Key)`, `seq(Id, Seq)`;
 * - `prev(Id, Before)`, `seen(Id, Other)`, `deleted(Id)`, `link(Id, Rel, To)`;
 * - `field(Id, Path, Value)` for each string, safe integer or boolean in the
 *   body, at its dotted path (`"a.b"`);
 * - `item(Id, Path, Index, Value)` for each such value in a list, and
 *   `size(Id, Path, N)` for each list.
 *
 * Nulls, and numbers that are not safe integers, have no fact: a contract
 * can't read them.
 */
export function factsOf(versions: Iterable<Version>): Fact[] {
  const out: Fact[] = [];
  for (const v of versions) {
    out.push(
      fact('record', v.id, v.collection, v.author),
      fact('key', v.id, v.key),
      fact('seq', v.id, v.seq),
    );
    if (v.prev) out.push(fact('prev', v.id, v.prev));
    if (v.deleted) out.push(fact('deleted', v.id));
    for (const s of v.seen) out.push(fact('seen', v.id, s));
    for (const l of v.links) out.push(fact('link', v.id, l.rel, l.to));
    flatten(v.id, '', v.body, out);
  }
  return out;
}

function scalar(x: Json): Term | null {
  if (typeof x === 'string' || typeof x === 'boolean') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x)) return x;
  return null;
}

function flatten(id: string, path: string, x: Json, out: Fact[]): void {
  if (Array.isArray(x)) {
    out.push(fact('size', id, path, x.length));
    x.forEach((item: Json, i: number) => {
      const t = scalar(item);
      if (t !== null) out.push(fact('item', id, path, i, t));
    });
    return;
  }
  if (typeof x === 'object' && x !== null) {
    for (const [k, v] of Object.entries(x)) flatten(id, path ? `${path}.${k}` : k, v, out);
    return;
  }
  const t = scalar(x);
  if (t !== null && path) out.push(fact('field', id, path, t));
}
