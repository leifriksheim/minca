/**
 * UCAN 1.0 policies (github.com/ucan-wg/delegation, "Policy"): the
 * conditions a delegation puts on an invocation's arguments. Enough of it
 * for the comparison: every operator, and selectors `.`, `.a.b`, `.a[0]`,
 * `.["a"]`, `.a[]` and a trailing `?` on a segment.
 *
 * A policy is a list of statements, all of which must hold. A selector that
 * finds nothing, without `?`, fails the whole policy (even under `not`), so
 * a missing field can never turn a "not" into a pass.
 */

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json };

export type Statement = ReadonlyArray<Json>;
export type Policy = ReadonlyArray<Statement>;

const MISSING = Symbol('missing');
/** Thrown when a selector without `?` finds nothing: the policy fails */
const NOT_FOUND = new Error('a selector found nothing');

/** Whether `args` meet every statement of `policy` */
export function allows(policy: Policy, args: Json): boolean {
  try {
    return policy.every((s) => holds(s, args));
  } catch (e) {
    if (e === NOT_FOUND) return false;
    throw e;
  }
}

function holds(s: Statement, at: Json): boolean {
  const [op, a, b] = s;
  switch (op) {
    case '==':
      return equal(select(str(a), at), b ?? null);
    case '!=':
      return !equal(select(str(a), at), b ?? null);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const x = select(str(a), at);
      if (typeof x !== 'number' || typeof b !== 'number') return false;
      return op === '<' ? x < b : op === '<=' ? x <= b : op === '>' ? x > b : x >= b;
    }
    case 'like': {
      const x = select(str(a), at);
      return typeof x === 'string' && typeof b === 'string' && glob(b).test(x);
    }
    case 'not':
      return !holds(statement(a), at);
    case 'and':
      return list(a).every((x) => holds(statement(x), at));
    case 'or':
      return list(a).some((x) => holds(statement(x), at));
    case 'all':
    case 'any': {
      const xs = select(str(a), at);
      const items = isList(xs) ? xs : isRecord(xs) ? Object.values(xs) : null;
      if (!items) return false;
      const each = (x: Json) => holds(statement(b ?? null), x);
      return op === 'all' ? items.every(each) : items.some(each);
    }
    default:
      throw new Error(`unknown policy operator ${JSON.stringify(op)}`);
  }
}

/** `*` matches any run of characters; `\*` is a literal star */
function glob(pattern: string): RegExp {
  const parts = pattern
    .split(/(\\\*|\*)/)
    .map((p) => (p === '*' ? '.*' : p === '\\*' ? '\\*' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('')}$`, 's');
}

/** Follows a selector from `at`. Throws NOT_FOUND when a segment without `?` finds nothing. */
function select(selector: string, at: Json): Json {
  if (!selector.startsWith('.')) throw new Error(`a selector starts with ".": ${selector}`);
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)(\?)?|\[(-?\d+)\](\?)?|\["([^"]*)"\](\?)?|\[\](\?)?|\.(\?)?/gy;
  let cur: Json = at;
  let m: RegExpExecArray | null;
  let i = 0;
  re.lastIndex = 0;
  while (i < selector.length && (m = re.exec(selector))) {
    i = re.lastIndex;
    const optional = Boolean(m[2] ?? m[4] ?? m[6] ?? m[7] ?? m[8]);
    let next: Json | typeof MISSING = MISSING;
    if (m[1] !== undefined || m[5] !== undefined) {
      const key = m[1] ?? m[5] ?? '';
      if (isRecord(cur) && Object.hasOwn(cur, key)) next = cur[key] ?? null;
    } else if (m[3] !== undefined) {
      const n = Number(m[3]);
      if (isList(cur)) next = cur.at(n) ?? MISSING;
    } else next = cur;
    if (next === MISSING) {
      if (optional) return null;
      throw NOT_FOUND;
    }
    cur = next;
  }
  if (i !== selector.length) throw new Error(`can't read selector ${selector}`);
  return cur;
}

function equal(x: Json, y: Json): boolean {
  if (x === y) return true;
  if (isList(x) && isList(y)) return x.length === y.length && x.every((v, i) => equal(v, y[i] ?? null));
  if (isRecord(x) && isRecord(y)) {
    const kx = Object.keys(x);
    return (
      kx.length === Object.keys(y).length &&
      kx.every((k) => Object.hasOwn(y, k) && equal(x[k] ?? null, y[k] ?? null))
    );
  }
  return false;
}

function isList(x: Json | undefined): x is ReadonlyArray<Json> {
  return Array.isArray(x);
}

export function isRecord(x: Json | undefined): x is { readonly [k: string]: Json } {
  return typeof x === 'object' && x !== null && !isList(x);
}
const str = (x: Json | undefined): string => (typeof x === 'string' ? x : '');
const list = (x: Json | undefined): ReadonlyArray<Json> => (isList(x) ? x : []);
const statement = (x: Json | undefined): Statement => (isList(x) ? x : []);
