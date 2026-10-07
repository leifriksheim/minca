/**
 * Conditions in CEL, the Common Expression Language (github.com/google/cel-spec):
 * a subset of it, judged the same on every peer.
 *
 * CEL is a small, side-effect-free expression language with a spec and a
 * conformance suite, used for policies in Kubernetes, Firebase and Envoy.
 * Every peer must reach the same verdict, so this is our own evaluator for a
 * subset of it, tested against that suite
 * (`packages/core/tests/cel-conformance.test.ts`): on every test there, it
 * either refuses the expression when it is checked, or gives the same result.
 *
 * Left out, and refused when checked: bytes, timestamps, durations, types as
 * values, messages, optionals, `matches` (regular expressions differ between
 * engines), `.?` and anything the space doesn't name. Added: the functions a
 * check needs to read a space (`versions`, `link`, `can`, `member`, `hash`,
 * `sum`), and from CEL's extensions `distinct()`, `math.greatest` and
 * `math.least`.
 *
 * Errors are values, as in CEL: `&&` and `||` absorb them when the other side
 * decides, and anything else that meets one gives an error. A condition holds
 * only when it gives `true`.
 */
import { canonicalize } from '../schema/version.js';
import { cidFromBytes } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';

// -- Values -----------------------------------------------------------------

/** An unsigned integer: kept apart from an int, as CEL does */
export interface CelUint {
  readonly uint: bigint;
}
/** A map: entries by an encoded key, so `1`, `1u` and `1.0` find the same one */
export interface CelMap {
  readonly map: ReadonlyMap<string, readonly [CelValue, CelValue]>;
}
/** An error, carried as a value until something decides without it */
export interface CelError {
  readonly error: string;
}
/** `int` is a bigint, `double` a number */
export type CelValue =
  null | boolean | bigint | number | string | CelUint | CelMap | CelError | ReadonlyArray<CelValue>;

const INT_MIN = -(2n ** 63n);
const INT_MAX = 2n ** 63n - 1n;
const UINT_MAX = 2n ** 64n - 1n;

const isList = (v: CelValue): v is ReadonlyArray<CelValue> => Array.isArray(v);
export const isUint = (v: CelValue): v is CelUint =>
  typeof v === 'object' && v !== null && !isList(v) && 'uint' in v;
export const isMap = (v: CelValue): v is CelMap =>
  typeof v === 'object' && v !== null && !isList(v) && 'map' in v;
export const isCelError = (v: CelValue): v is CelError =>
  typeof v === 'object' && v !== null && !isList(v) && 'error' in v;
const err = (error: string): CelError => Object.freeze({ error });
const uint = (value: bigint): CelUint => Object.freeze({ uint: value });

const int = (value: bigint): CelValue =>
  value < INT_MIN || value > INT_MAX ? err('integer overflow') : value;
const toUint = (value: bigint): CelValue =>
  value < 0n || value > UINT_MAX ? err('unsigned overflow') : uint(value);

/** The key a map files a value under, or null for one that can't be a key */
function keyOf(v: CelValue): string | null {
  if (typeof v === 'string') return `s:${v}`;
  if (typeof v === 'boolean') return `b:${v}`;
  if (typeof v === 'bigint') return `n:${v}`;
  if (isUint(v)) return `n:${v.uint}`;
  return null;
}

/** The key to look a value up under: an integral double finds the int */
function lookupKeyOf(v: CelValue): string | null {
  if (typeof v === 'number') return Number.isInteger(v) ? `n:${BigInt(v)}` : 'x:';
  return keyOf(v);
}

/** A map's keys in a fixed order: false before true, numbers rising, then strings as canonical JSON orders them */
function keysInOrder(m: CelMap): CelValue[] {
  const rank = (k: CelValue) => (typeof k === 'boolean' ? 0 : typeof k === 'string' ? 2 : 1);
  return [...m.map.values()]
    .map(([k]) => k)
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
      if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
      return compareNumbers(a, b) ?? 0;
    });
}

export function celMap(entries: ReadonlyArray<readonly [CelValue, CelValue]>): CelValue {
  const map = new Map<string, readonly [CelValue, CelValue]>();
  for (const [k, v] of entries) {
    const key = keyOf(k);
    if (key === null) return err('unsupported key type');
    if (map.has(key)) return err('duplicate key in map');
    map.set(key, [k, v]);
  }
  return Object.freeze({ map });
}

/** JSON as CEL reads it: numbers are doubles, objects maps with string keys */
export function fromJson(value: unknown): CelValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(fromJson);
  if (typeof value === 'object') {
    const map = new Map<string, readonly [CelValue, CelValue]>();
    for (const [k, v] of Object.entries(value)) map.set(`s:${k}`, [k, fromJson(v)]);
    return Object.freeze({ map });
  }
  return null;
}

/** A value as JSON, for `hash`: ints as numbers when exact, maps only with string keys */
function toJson(v: CelValue): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('not finite');
    return v;
  }
  if (typeof v === 'bigint' || isUint(v)) {
    const n = typeof v === 'bigint' ? v : v.uint;
    if (n > 2n ** 53n || n < -(2n ** 53n)) throw new TypeError('too large for JSON');
    return Number(n);
  }
  if (isList(v)) return v.map(toJson);
  if (isMap(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, value] of v.map.values()) {
      if (typeof k !== 'string') throw new TypeError('a map key that is not a string');
      out[k] = toJson(value);
    }
    return out;
  }
  throw new TypeError('an error');
}

// -- Comparing ----------------------------------------------------------------

/** Comparison of two numbers of any kind: negative, zero, positive, or null when either is NaN */
function compareNumbers(a: CelValue, b: CelValue): number | null {
  const big = (v: CelValue) => (typeof v === 'bigint' ? v : isUint(v) ? v.uint : null);
  const ba = big(a);
  const bb = big(b);
  if (ba !== null && bb !== null) return ba < bb ? -1 : ba > bb ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // An integer against a double compares as doubles, as CEL does: lossy past 2^53.
  if (ba !== null && typeof b === 'number') return compareNumbers(Number(ba), b);
  if (typeof a === 'number' && bb !== null) return compareNumbers(a, Number(bb));
  return null;
}

const isNumber = (v: CelValue) => typeof v === 'bigint' || typeof v === 'number' || isUint(v);

/** Strings in code point order, as CEL compares them */
function compareStrings(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

/** Equality across kinds: numbers by value, lists and maps by content, anything else unequal */
function celEquals(a: CelValue, b: CelValue): boolean {
  if (isNumber(a) && isNumber(b)) return compareNumbers(a, b) === 0;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (isList(a) || isList(b)) {
    if (!isList(a) || !isList(b) || a.length !== b.length) return false;
    return a.every((item, i) => celEquals(item, b[i]!));
  }
  if (isMap(a) && isMap(b)) {
    if (a.map.size !== b.map.size) return false;
    for (const [key, [, value]] of a.map) {
      const other = b.map.get(key);
      if (!other || !celEquals(value, other[1])) return false;
    }
    return true;
  }
  return false;
}

// -- Parsing ------------------------------------------------------------------

/** A parsed expression */
export type CelNode =
  | { readonly k: 'lit'; readonly v: CelValue }
  | { readonly k: 'ident'; readonly name: string }
  | { readonly k: 'select'; readonly on: CelNode; readonly field: string; readonly test: boolean }
  | { readonly k: 'index'; readonly on: CelNode; readonly at: CelNode }
  | {
      readonly k: 'call';
      readonly fn: string;
      readonly target: CelNode | null;
      readonly args: ReadonlyArray<CelNode>;
    }
  | { readonly k: 'list'; readonly items: ReadonlyArray<CelNode> }
  | { readonly k: 'map'; readonly entries: ReadonlyArray<readonly [CelNode, CelNode]> }
  | { readonly k: 'cond'; readonly test: CelNode; readonly then: CelNode; readonly else: CelNode }
  | { readonly k: 'and' | 'or'; readonly l: CelNode; readonly r: CelNode }
  | {
      readonly k: 'comp';
      readonly macro: 'all' | 'exists' | 'exists_one' | 'map' | 'filter';
      readonly range: CelNode;
      readonly v: string;
      readonly pred: CelNode | null;
      readonly out: CelNode | null;
    };

type Token =
  | { readonly t: 'int'; readonly v: bigint }
  | { readonly t: 'uint'; readonly v: bigint }
  | { readonly t: 'double'; readonly v: number }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'id'; readonly v: string }
  | { readonly t: 'op'; readonly v: string }
  | { readonly t: 'eof' };

/** What the parser throws: the expression is malformed, or outside the subset */
const problem = (message: string) => Object.assign(new Error(message), { celProblem: true });
export const isCelProblem = (e: unknown): e is Error => e instanceof Error && 'celProblem' in e;

const RESERVED = new Set(
  'as break const continue else for function if import let loop package namespace return var void while'.split(
    ' ',
  ),
);
const OPS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%',
  '?',
  ':',
  '.',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  ',',
];

function lex(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const at = (n = 0) => source[i + n] ?? '';
  const digit = (c: string) => c >= '0' && c <= '9';
  const hex = (c: string) => /^[0-9a-fA-F]$/.test(c);
  while (i < source.length) {
    const c = at();
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '/' && at(1) === '/') {
      while (i < source.length && at() !== '\n') i++;
      continue;
    }
    // Numbers
    if (digit(c) || (c === '.' && digit(at(1)))) {
      const start = i;
      if (c === '0' && (at(1) === 'x' || at(1) === 'X')) {
        i += 2;
        while (hex(at())) i++;
        if (i === start + 2) throw problem('a hex number with no digits');
        const v = BigInt(source.slice(start, i));
        if (at() === 'u' || at() === 'U') {
          i++;
          out.push({ t: 'uint', v });
        } else out.push({ t: 'int', v });
        continue;
      }
      while (digit(at())) i++;
      let isDouble = false;
      if (at() === '.' && digit(at(1))) {
        isDouble = true;
        i++;
        while (digit(at())) i++;
      }
      if (at() === 'e' || at() === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j++;
        if (digit(source[j] ?? '')) {
          isDouble = true;
          i = j;
          while (digit(at())) i++;
        }
      }
      const text = source.slice(start, i);
      if (isDouble) out.push({ t: 'double', v: Number(text) });
      else if (at() === 'u' || at() === 'U') {
        i++;
        out.push({ t: 'uint', v: BigInt(text) });
      } else out.push({ t: 'int', v: BigInt(text) });
      if (/[A-Za-z_]/.test(at())) throw problem(`a number runs into "${at()}"`);
      continue;
    }
    // Strings, with their prefixes
    const prefix = /^([rRbB]{1,2})?(['"])/.exec(source.slice(i, i + 3));
    if (prefix && (prefix[1] === undefined || /^(r|R|b|B|rb|rB|Rb|RB|br|bR|Br|BR)$/.test(prefix[1]))) {
      const flags = (prefix[1] ?? '').toLowerCase();
      if (flags.includes('b')) throw problem('bytes are not in the subset');
      const raw = flags.includes('r');
      i += flags.length;
      const q = at();
      const triple = at(1) === q && at(2) === q;
      const close = triple ? q.repeat(3) : q;
      i += close.length;
      let value = '';
      for (;;) {
        if (i >= source.length) throw problem('a string that never ends');
        if (source.startsWith(close, i)) {
          i += close.length;
          break;
        }
        const ch = at();
        if (!triple && (ch === '\n' || ch === '\r')) throw problem('a new line in a string');
        if (ch === '\\' && !raw) {
          const e = at(1);
          const simple: Record<string, string> = {
            a: '\x07',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
            v: '\v',
            '\\': '\\',
            "'": "'",
            '"': '"',
            '`': '`',
            '?': '?',
          };
          if (e in simple) {
            value += simple[e];
            i += 2;
            continue;
          }
          let code: number;
          if (e === 'x' || e === 'X' || e === 'u' || e === 'U') {
            const n = e === 'u' ? 4 : e === 'U' ? 8 : 2;
            const digits = source.slice(i + 2, i + 2 + n);
            if (digits.length !== n || ![...digits].every(hex)) throw problem('a bad escape');
            code = parseInt(digits, 16);
            i += 2 + n;
          } else if (/^[0-3][0-7][0-7]$/.test(source.slice(i + 1, i + 4))) {
            code = parseInt(source.slice(i + 1, i + 4), 8);
            i += 4;
          } else throw problem('a bad escape');
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
            throw problem('an escape that is no character');
          value += String.fromCodePoint(code);
          continue;
        }
        const cp = source.codePointAt(i)!;
        value += String.fromCodePoint(cp);
        i += cp > 0xffff ? 2 : 1;
      }
      out.push({ t: 'str', v: value });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (/[A-Za-z0-9_]/.test(at())) i++;
      out.push({ t: 'id', v: source.slice(start, i) });
      continue;
    }
    if ((c === '.' && at(1) === '?') || (c === '?' && at(1) === '.') || (c === '?' && at(1) === '['))
      throw problem('optionals are not in the subset');
    const op = OPS.find((o) => source.startsWith(o, i));
    if (!op) throw problem(`unexpected "${c}"`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'eof' });
  return out;
}

const MACROS = new Set(['all', 'exists', 'exists_one', 'map', 'filter']);
/** How deeply brackets, calls and macros may nest */
const MAX_CEL_DEPTH = 32;

/** Parses an expression, or throws a `CelProblem` */
export function parseCel(source: string): CelNode {
  const tokens = lex(source);
  let p = 0;
  let depth = 0;
  const peek = () => tokens[p]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === 'op' && t.v === v;
  };
  const take = (v: string) => {
    if (!isOp(v)) throw problem(`expected "${v}"`);
    p++;
  };
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_CEL_DEPTH) throw problem(`nested more than ${MAX_CEL_DEPTH} deep`);
    const r = f();
    depth--;
    return r;
  };

  const expr = (): CelNode => {
    const test = or();
    if (!isOp('?')) return test;
    p++;
    const then = or();
    take(':');
    const otherwise = expr();
    return { k: 'cond', test, then, else: otherwise };
  };
  const or = (): CelNode => {
    let l = and();
    while (isOp('||')) {
      p++;
      l = { k: 'or', l, r: and() };
    }
    return l;
  };
  const and = (): CelNode => {
    let l = relation();
    while (isOp('&&')) {
      p++;
      l = { k: 'and', l, r: relation() };
    }
    return l;
  };
  const relation = (): CelNode => {
    let l = calc();
    for (;;) {
      const t = peek();
      const op =
        t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)
          ? t.v
          : t.t === 'id' && t.v === 'in'
            ? 'in'
            : null;
      if (!op) return l;
      p++;
      l = { k: 'call', fn: op, target: null, args: [l, calc()] };
    }
  };
  const calc = (): CelNode => {
    let l = mult();
    while (isOp('+') || isOp('-')) {
      const t = peek();
      p++;
      l = { k: 'call', fn: t.t === 'op' ? t.v : '', target: null, args: [l, mult()] };
    }
    return l;
  };
  const mult = (): CelNode => {
    let l = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const t = peek();
      p++;
      l = { k: 'call', fn: t.t === 'op' ? t.v : '', target: null, args: [l, unary()] };
    }
    return l;
  };
  const unary = (): CelNode => {
    if (isOp('!') || isOp('-')) {
      const t = peek();
      const op = t.t === 'op' ? t.v : '';
      let n = 0;
      while (isOp(op)) {
        p++;
        n++;
      }
      const next = peek();
      // A minus right before a number is part of it, so the least int can be written.
      let node: CelNode;
      if (op === '-' && (next.t === 'int' || next.t === 'double')) {
        const inner = member();
        if (inner.k === 'lit' && (typeof inner.v === 'bigint' || typeof inner.v === 'number')) {
          node = { k: 'lit', v: -inner.v };
          n--;
        } else node = inner;
      } else node = member();
      node = checkedLiteral(node);
      for (let i = 0; i < n; i++)
        node = { k: 'call', fn: op === '-' ? 'neg' : '!', target: null, args: [node] };
      return node;
    }
    return checkedLiteral(member());
  };
  const checkedLiteral = (node: CelNode): CelNode => {
    if (node.k === 'lit' && typeof node.v === 'bigint' && (node.v < INT_MIN || node.v > INT_MAX))
      throw problem('an int literal out of range');
    return node;
  };
  const args = (close: string): CelNode[] => {
    const out: CelNode[] = [];
    if (isOp(close)) {
      p++;
      return out;
    }
    for (;;) {
      out.push(expr());
      if (isOp(',')) {
        p++;
        continue;
      }
      take(close);
      return out;
    }
  };
  const ident = (): string => {
    const t = peek();
    if (t.t !== 'id') throw problem('expected a name');
    if (RESERVED.has(t.v) || ['in', 'true', 'false', 'null'].includes(t.v))
      throw problem(`"${t.v}" is reserved`);
    p++;
    return t.v;
  };
  const macro = (name: string, target: CelNode, list: CelNode[]): CelNode | null => {
    if (!MACROS.has(name)) return null;
    const n = list.length;
    if (!(n === 2 || (name === 'map' && n === 3))) return null;
    const v = list[0]!;
    if (v.k !== 'ident') throw problem(`${name}: the first argument must be a name`);
    if (name === 'map')
      return {
        k: 'comp',
        macro: 'map',
        range: target,
        v: v.name,
        pred: n === 3 ? list[1]! : null,
        out: list[n - 1]!,
      };
    if (name === 'all' || name === 'exists' || name === 'exists_one' || name === 'filter')
      return { k: 'comp', macro: name, range: target, v: v.name, pred: list[1]!, out: null };
    return null;
  };
  const member = (): CelNode => {
    let node = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        const name = ident();
        if (isOp('(')) {
          p++;
          const list = nest(() => args(')'));
          node = macro(name, node, list) ?? { k: 'call', fn: name, target: node, args: list };
        } else node = { k: 'select', on: node, field: name, test: false };
      } else if (isOp('[')) {
        p++;
        const at = nest(() => expr());
        take(']');
        node = { k: 'index', on: node, at };
      } else if (isOp('{')) throw problem('messages are not in the subset');
      else return node;
    }
  };
  const primary = (): CelNode => {
    const t = peek();
    if (t.t === 'int' || t.t === 'double' || t.t === 'str') {
      p++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'uint') {
      p++;
      if (t.v > UINT_MAX) throw problem('a uint literal out of range');
      return { k: 'lit', v: uint(t.v) };
    }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') {
        p++;
        return { k: 'lit', v: t.v === 'true' };
      }
      if (t.v === 'null') {
        p++;
        return { k: 'lit', v: null };
      }
      const name = ident();
      if (isOp('(')) {
        p++;
        const list = nest(() => args(')'));
        if (name === 'has') {
          const arg = list[0];
          if (list.length !== 1 || !arg || arg.k !== 'select')
            throw problem('has() takes one field selection');
          return { ...arg, test: true };
        }
        return { k: 'call', fn: name, target: null, args: list };
      }
      return { k: 'ident', name };
    }
    if (isOp('.')) throw problem('a leading "." is not in the subset');
    if (isOp('(')) {
      p++;
      const inner = nest(() => expr());
      take(')');
      return inner;
    }
    if (isOp('[')) {
      p++;
      return { k: 'list', items: nest(() => args(']')) };
    }
    if (isOp('{')) {
      p++;
      return nest(() => {
        const entries: Array<readonly [CelNode, CelNode]> = [];
        while (!isOp('}')) {
          const key = expr();
          take(':');
          entries.push([key, expr()]);
          if (!isOp(',')) break;
          p++;
        }
        take('}');
        return { k: 'map', entries };
      });
    }
    throw problem('unexpected end, or a token out of place');
  };

  const node = expr();
  if (peek().t !== 'eof') throw problem('something follows the expression');
  return node;
}

// -- Checking -----------------------------------------------------------------

/** Functions called by name, with how many arguments each takes */
const GLOBALS: Readonly<Record<string, ReadonlyArray<number>>> = {
  size: [1],
  int: [1],
  uint: [1],
  double: [1],
  string: [1],
  bool: [1],
  dyn: [1],
  sum: [1],
  hash: [1],
  versions: [1],
  link: [1],
  can: [1, 2],
  member: [1],
  '==': [2],
  '!=': [2],
  '<': [2],
  '<=': [2],
  '>': [2],
  '>=': [2],
  in: [2],
  '+': [2],
  '-': [2],
  '*': [2],
  '/': [2],
  '%': [2],
  '!': [1],
  neg: [1],
};
/** Functions called on a value */
const METHODS: Readonly<Record<string, ReadonlyArray<number>>> = {
  size: [0],
  contains: [1],
  startsWith: [1],
  endsWith: [1],
  distinct: [0],
  link: [1],
};
/** Functions read from the space: an expression that reads only a record leaves them out */
const SPACE_FUNCTIONS = new Set(['versions', 'can', 'member']);

/** What an expression may name and call */
export interface CelScope {
  /** The variables it reads */
  readonly names: ReadonlySet<string>;
  /** The permissions `can` may name; without it, `can` is refused */
  readonly permissions?: ReadonlyArray<string>;
  /** Whether it may read the space (`versions`, `can`, `member`) */
  readonly space?: boolean;
  /** Literal link roles `link` accepts */
  readonly linkRel?: RegExp;
}

/** Problems with an expression for a scope, or null. Counts its nodes into `count`. */
export function checkCel(node: CelNode, scope: CelScope, count = { nodes: 0 }): string | null {
  const walk = (n: CelNode, bound: ReadonlySet<string>): string | null => {
    count.nodes++;
    switch (n.k) {
      case 'lit':
        return null;
      case 'ident':
        return bound.has(n.name) || scope.names.has(n.name)
          ? null
          : `"${n.name}" is not something it can read`;
      case 'select':
        return walk(n.on, bound);
      case 'index':
        return walk(n.on, bound) ?? walk(n.at, bound);
      case 'list':
        return first(n.items.map((item) => () => walk(item, bound)));
      case 'map':
        return first(n.entries.flatMap(([k, v]) => [() => walk(k, bound), () => walk(v, bound)]));
      case 'cond':
        return walk(n.test, bound) ?? walk(n.then, bound) ?? walk(n.else, bound);
      case 'and':
      case 'or':
        return walk(n.l, bound) ?? walk(n.r, bound);
      case 'comp': {
        const inner = new Set(bound).add(n.v);
        return (
          walk(n.range, bound) ?? (n.pred ? walk(n.pred, inner) : null) ?? (n.out ? walk(n.out, inner) : null)
        );
      }
      case 'call': {
        const isMath =
          n.target?.k === 'ident' &&
          n.target.name === 'math' &&
          !bound.has('math') &&
          !scope.names.has('math');
        if (isMath) {
          if (n.fn !== 'greatest' && n.fn !== 'least') return `math.${n.fn} is not in the subset`;
          if (n.args.length === 0) return `math.${n.fn} takes at least one argument`;
          return first(n.args.map((a) => () => walk(a, bound)));
        }
        const table = n.target ? METHODS : GLOBALS;
        const arity = Object.hasOwn(table, n.fn) ? table[n.fn] : undefined;
        if (!arity) return `${n.target ? '.' : ''}${n.fn}() is not in the subset`;
        if (!arity.includes(n.args.length)) return `${n.fn}() takes ${arity.join(' or ')} arguments`;
        if (!n.target && SPACE_FUNCTIONS.has(n.fn) && !scope.space)
          return `${n.fn}() asks the space, which this can't`;
        if (n.fn === 'link') {
          const rel = n.args[0]!;
          if (rel.k !== 'lit' || typeof rel.v !== 'string' || (scope.linkRel && !scope.linkRel.test(rel.v)))
            return 'link() takes a literal link role';
        }
        if (n.fn === 'can' && !n.target) {
          const permission = n.args[0]!;
          if (
            permission.k !== 'lit' ||
            typeof permission.v !== 'string' ||
            !(scope.permissions ?? []).includes(permission.v)
          )
            return 'can() takes a literal permission the definition declares';
        }
        return (n.target ? walk(n.target, bound) : null) ?? first(n.args.map((a) => () => walk(a, bound)));
      }
    }
  };
  return walk(node, new Set());
}

function first(checks: ReadonlyArray<() => string | null>): string | null {
  for (const check of checks) {
    const problem = check();
    if (problem) return problem;
  }
  return null;
}

// -- Evaluating ---------------------------------------------------------------

/** Stops an evaluation outright: a cited version not here yet, one that can't be read or doesn't stand, or too many steps */
export interface CelStop {
  readonly stop: 'later' | 'unreadable' | 'fail';
  readonly why: string;
}
/** A stop, thrown */
export const celStop = (stop: CelStop['stop'], why: string): Error & CelStop =>
  Object.assign(new Error(why), { stop, why });
export const isCelStop = (e: unknown): e is CelStop =>
  typeof e === 'object' && e !== null && 'stop' in e && typeof e.stop === 'string';

/** What an evaluation reads, and asks */
export interface CelEnv {
  readonly vars: ReadonlyMap<string, CelValue>;
  /** The links of the version judged, for `link(rel)` */
  readonly links?: CelValue;
  /** Cited versions, as CEL values; may throw a `CelStop` */
  readonly versions?: (ids: ReadonlyArray<string>) => Promise<CelValue>;
  readonly can?: (permission: string, did: string) => boolean;
  readonly member?: (did: string) => boolean;
  /** The account `can(p)` asks about */
  readonly author?: string;
}

/** Steps an evaluation may take: every node evaluated, and every element a macro goes through */
export const MAX_CEL_STEPS = 10_000;

/** Evaluates an expression. Throws a `CelStop`; any other failure is an error value. */
export async function evaluateCel(
  node: CelNode,
  env: CelEnv,
  budget = { steps: 0, max: MAX_CEL_STEPS },
): Promise<CelValue> {
  const step = () => {
    if (++budget.steps > budget.max) throw celStop('fail', 'took too many steps');
  };
  const ev = async (n: CelNode, scope: ReadonlyMap<string, CelValue>): Promise<CelValue> => {
    step();
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'ident':
        return scope.has(n.name) ? scope.get(n.name)! : err(`no value for ${n.name}`);
      case 'select': {
        const on = await ev(n.on, scope);
        if (isCelError(on)) return on;
        if (!isMap(on)) return err('no such field');
        const found = on.map.get(`s:${n.field}`);
        if (n.test) return found !== undefined;
        return found ? found[1] : err(`no such key: ${n.field}`);
      }
      case 'index': {
        const on = await ev(n.on, scope);
        if (isCelError(on)) return on;
        const at = await ev(n.at, scope);
        if (isCelError(at)) return at;
        if (isList(on)) {
          const i =
            typeof at === 'bigint'
              ? at
              : isUint(at)
                ? at.uint
                : typeof at === 'number' && Number.isInteger(at)
                  ? BigInt(at)
                  : null;
          if (i === null) return err('no such overload');
          return i >= 0n && i < BigInt(on.length) ? on[Number(i)]! : err('index out of range');
        }
        if (isMap(on)) {
          const key = lookupKeyOf(at);
          if (key === null) return err('unsupported key type');
          const found = on.map.get(key);
          return found ? found[1] : err('no such key');
        }
        return err('no such overload');
      }
      case 'list': {
        const out: CelValue[] = [];
        for (const item of n.items) {
          const v = await ev(item, scope);
          if (isCelError(v)) return v;
          out.push(v);
        }
        return out;
      }
      case 'map': {
        const entries: Array<readonly [CelValue, CelValue]> = [];
        for (const [kn, vn] of n.entries) {
          const k = await ev(kn, scope);
          if (isCelError(k)) return k;
          const v = await ev(vn, scope);
          if (isCelError(v)) return v;
          entries.push([k, v]);
        }
        return celMap(entries);
      }
      case 'cond': {
        const test = await ev(n.test, scope);
        if (isCelError(test)) return test;
        if (typeof test !== 'boolean') return err('no matching overload');
        return ev(test ? n.then : n.else, scope);
      }
      case 'and':
      case 'or': {
        // The left first; the right only when the left doesn't decide. An error gives way to a deciding side.
        const decides = n.k === 'or';
        const l = await ev(n.l, scope);
        if (l === decides) return decides;
        const r = await ev(n.r, scope);
        if (r === decides) return decides;
        if (isCelError(l)) return l;
        if (isCelError(r)) return r;
        if (typeof l !== 'boolean' || typeof r !== 'boolean') return err('no matching overload');
        return !decides;
      }
      case 'comp': {
        const range = await ev(n.range, scope);
        if (isCelError(range)) return range;
        const items = isList(range) ? range : isMap(range) ? keysInOrder(range) : null;
        if (!items) return err('no matching overload');
        const inner = new Map(scope);
        if (n.macro === 'all' || n.macro === 'exists') {
          const decides = n.macro === 'exists';
          let error: CelError | null = null;
          for (const item of items) {
            step();
            inner.set(n.v, item);
            const r = await ev(n.pred!, inner);
            if (r === decides) return decides;
            if (isCelError(r)) error ??= r;
            else if (typeof r !== 'boolean') error ??= err('no matching overload');
          }
          return error ?? !decides;
        }
        if (n.macro === 'exists_one') {
          let count = 0;
          for (const item of items) {
            step();
            inner.set(n.v, item);
            const r = await ev(n.pred!, inner);
            if (isCelError(r)) return r;
            if (typeof r !== 'boolean') return err('no matching overload');
            if (r) count++;
          }
          return count === 1;
        }
        const out: CelValue[] = [];
        for (const item of items) {
          step();
          inner.set(n.v, item);
          if (n.pred) {
            const keep = await ev(n.pred, inner);
            if (isCelError(keep)) return keep;
            if (typeof keep !== 'boolean') return err('no matching overload');
            if (!keep) continue;
          }
          const v = n.out ? await ev(n.out, inner) : item;
          if (isCelError(v)) return v;
          out.push(v);
        }
        return out;
      }
      case 'call': {
        if (n.target?.k === 'ident' && n.target.name === 'math' && !scope.has('math')) {
          const args = await evalArgs(n.args, scope);
          if (isCelError(args)) return args;
          return extreme(
            args.length === 1 && isList(args[0]!) ? args[0] : args,
            n.fn === 'greatest' ? 1 : -1,
          );
        }
        let target: CelValue | undefined;
        if (n.target) {
          target = await ev(n.target, scope);
          if (isCelError(target)) return target;
        }
        // Cited versions are looked up only when every argument came out.
        const args = await evalArgs(n.args, scope);
        if (isCelError(args)) return args;
        return target === undefined ? callGlobal(n.fn, args, env) : callMethod(n.fn, target, args);
      }
    }
  };
  const evalArgs = async (nodes: ReadonlyArray<CelNode>, scope: ReadonlyMap<string, CelValue>) => {
    const out: CelValue[] = [];
    for (const a of nodes) {
      const v = await ev(a, scope);
      if (isCelError(v)) return v;
      out.push(v);
    }
    return out;
  };
  return ev(node, env.vars);
}

function extreme(values: CelValue, sign: number): CelValue {
  if (!isList(values) || values.length === 0) return err('math needs at least one number');
  let best: CelValue = values[0]!;
  for (const v of values) {
    if (!isNumber(v)) return err('no matching overload');
    const c = compareNumbers(v, best);
    if (c === null) return err('NaN has no order');
    if (c * sign > 0) best = v;
  }
  return best;
}

function arith(op: string, a: CelValue, b: CelValue): CelValue {
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    if (op === '+') return int(a + b);
    if (op === '-') return int(a - b);
    if (op === '*') return int(a * b);
    if (b === 0n) return err(op === '/' ? 'divide by zero' : 'modulus by zero');
    return int(op === '/' ? a / b : a % b);
  }
  if (isUint(a) && isUint(b)) {
    if (op === '+') return toUint(a.uint + b.uint);
    if (op === '-') return toUint(a.uint - b.uint);
    if (op === '*') return toUint(a.uint * b.uint);
    if (b.uint === 0n) return err(op === '/' ? 'divide by zero' : 'modulus by zero');
    return uint(op === '/' ? a.uint / b.uint : a.uint % b.uint);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/') return a / b;
    return err('no matching overload');
  }
  if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  if (op === '+' && isList(a) && isList(b)) return [...a, ...b];
  return err('no matching overload');
}

async function callGlobal(fn: string, args: ReadonlyArray<CelValue>, env: CelEnv): Promise<CelValue> {
  const [a, b] = [args[0]!, args[1]!];
  switch (fn) {
    case '==':
      return celEquals(a, b);
    case '!=':
      return !celEquals(a, b);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      let c: number | null;
      if (isNumber(a) && isNumber(b)) c = compareNumbers(a, b);
      else if (typeof a === 'string' && typeof b === 'string') c = compareStrings(a, b);
      else if (typeof a === 'boolean' && typeof b === 'boolean') c = Number(a) - Number(b);
      else return err('no matching overload');
      if (c === null) return false;
      return fn === '<' ? c < 0 : fn === '<=' ? c <= 0 : fn === '>' ? c > 0 : c >= 0;
    }
    case 'in':
      if (isList(b)) return b.some((item) => celEquals(a, item));
      if (isMap(b)) {
        const key = lookupKeyOf(a);
        return key !== null && b.map.has(key);
      }
      return err('no matching overload');
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return arith(fn, a, b);
    case '!':
      return typeof a === 'boolean' ? !a : err('no matching overload');
    case 'neg':
      if (typeof a === 'bigint') return int(-a);
      if (typeof a === 'number') return -a;
      return err('no matching overload');
    case 'size':
      return callMethod('size', a, []);
    case 'int':
      if (typeof a === 'bigint') return a;
      if (isUint(a)) return int(a.uint);
      if (typeof a === 'number') {
        if (!Number.isFinite(a) || a <= -(2 ** 63) || a >= 2 ** 63) return err('range error');
        return int(BigInt(Math.trunc(a)));
      }
      if (typeof a === 'string') return /^[+-]?\d+$/.test(a) ? int(BigInt(a)) : err('bad int');
      return err('no matching overload');
    case 'uint':
      if (isUint(a)) return a;
      if (typeof a === 'bigint') return toUint(a);
      if (typeof a === 'number') {
        if (!Number.isFinite(a) || a < 0 || a >= 2 ** 64) return err('range error');
        return toUint(BigInt(Math.trunc(a)));
      }
      if (typeof a === 'string') return /^\+?\d+$/.test(a) ? toUint(BigInt(a)) : err('bad uint');
      return err('no matching overload');
    case 'double':
      if (typeof a === 'number') return a;
      if (typeof a === 'bigint') return Number(a);
      if (isUint(a)) return Number(a.uint);
      if (typeof a === 'string') {
        const lower = a.toLowerCase();
        if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith('-') ? -Infinity : Infinity;
        if (/^[+-]?nan$/.test(lower)) return NaN;
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(a)) return err('bad double');
        const v = Number(a);
        return Number.isFinite(v) ? v : err('range error');
      }
      return err('no matching overload');
    case 'string':
      if (typeof a === 'string') return a;
      if (typeof a === 'bigint') return a.toString();
      if (isUint(a)) return a.uint.toString();
      if (typeof a === 'boolean') return String(a);
      if (typeof a === 'number') return doubleText(a);
      return err('no matching overload');
    case 'bool':
      if (typeof a === 'boolean') return a;
      if (typeof a === 'string') {
        if (['1', 't', 'T', 'true', 'TRUE', 'True'].includes(a)) return true;
        if (['0', 'f', 'F', 'false', 'FALSE', 'False'].includes(a)) return false;
        return err('bad bool');
      }
      return err('no matching overload');
    case 'dyn':
      return a;
    case 'sum': {
      if (!isList(a)) return err('no matching overload');
      if (a.length === 0) return 0n;
      let total: CelValue = a[0]!;
      if (!isNumber(total)) return err('no matching overload');
      for (const item of a.slice(1)) {
        total = arith('+', total, item);
        if (isCelError(total)) return total;
      }
      return total;
    }
    case 'hash':
      try {
        return await cidFromBytes(utf8Encode(canonicalize(toJson(a))));
      } catch {
        return err('cannot hash');
      }
    case 'link':
      return linkOf(env.links ?? [], a);
    case 'versions': {
      if (!isList(a) || !a.every((id) => typeof id === 'string'))
        return err('versions() takes a list of ids');
      if (!env.versions) return err('nothing to cite');
      return env.versions(a.filter((id) => typeof id === 'string'));
    }
    case 'can': {
      const did = args.length === 2 ? b : (env.author ?? null);
      if (typeof a !== 'string' || typeof did !== 'string' || !did.startsWith('did:'))
        return err('no matching overload');
      return env.can ? env.can(a, did) : false;
    }
    case 'member':
      if (typeof a !== 'string' || !a.startsWith('did:')) return err('no matching overload');
      return env.member ? env.member(a) : false;
  }
  return err(`no function ${fn}`);
}

/**
 * A double as text, the way CEL's reference implementation writes it (Go's
 * `%g`): the shortest digits that read back the same, with an exponent
 * below 1e-4 or from 1e6 up.
 */
function doubleText(d: number): string {
  if (Number.isNaN(d)) return 'NaN';
  if (d === Infinity) return '+Inf';
  if (d === -Infinity) return '-Inf';
  if (d === 0) return Object.is(d, -0) ? '-0' : '0';
  const [mantissa, e] = d.toExponential().split('e');
  const exp = Number(e);
  const sign = mantissa!.startsWith('-') ? '-' : '';
  const digits = mantissa!.replace('-', '').replace('.', '');
  if (exp < -4 || exp >= 6) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${'0'.repeat(exp + 1 - digits.length)}`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

function linkOf(links: CelValue, rel: CelValue): CelValue {
  if (!isList(links) || typeof rel !== 'string') return err('no matching overload');
  for (const link of links) {
    if (!isMap(link)) continue;
    const r = link.map.get('s:rel');
    const to = link.map.get('s:to');
    if (r && r[1] === rel) return to ? to[1] : null;
  }
  return null;
}

function callMethod(fn: string, target: CelValue, args: ReadonlyArray<CelValue>): CelValue {
  const a = args[0]!;
  switch (fn) {
    case 'size':
      if (typeof target === 'string') return BigInt([...target].length);
      if (isList(target)) return BigInt(target.length);
      if (isMap(target)) return BigInt(target.map.size);
      return err('no matching overload');
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      if (typeof target !== 'string' || typeof a !== 'string') return err('no matching overload');
      return fn === 'contains'
        ? target.includes(a)
        : fn === 'startsWith'
          ? target.startsWith(a)
          : target.endsWith(a);
    case 'distinct': {
      if (!isList(target)) return err('no matching overload');
      const out: CelValue[] = [];
      for (const item of target) if (!out.some((seen) => celEquals(seen, item))) out.push(item);
      return out;
    }
    case 'link':
      if (!isMap(target)) return err('no matching overload');
      return linkOf(target.map.get('s:links')?.[1] ?? [], a);
  }
  return err(`no function .${fn}`);
}
