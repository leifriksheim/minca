/** The versions a scenario holds, as the facts a Datalog program reads. */
import { fact, type Fact, type Term } from './datalog.js';
import type { Json } from '../host/ucan-policy.js';
import type { Version } from '../host/space.js';

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
