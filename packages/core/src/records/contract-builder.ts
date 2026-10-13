/**
 * Contracts written in TypeScript: `contract(schema, ({ body }) => …, else)`
 * builds the CEL a definition's `contract.check` stores, with the body's fields
 * and types from the collection's schema. Peers still see CEL: this is the
 * library's way to write it, as a query builder writes SQL.
 *
 * Every value is an expression with methods for its type: `.eq`, `.gte`,
 * `.and`, `.where`, `.map`. Literals take the kind CEL needs where they are
 * used (`0` next to a body's number is `0.0`, next to a size `0`). What it
 * doesn't cover, `raw(cel)` writes by hand.
 */
import type { BodyOf } from '../query/types.js';
import { toJsonSchema } from '../schema/collection-def.js';
import { isObject } from '../utils/guards.js';
import {
  BOOL,
  DOUBLE,
  DYN,
  INT,
  STRING,
  listOf,
  typeOfSchema,
  versionType,
  type CelType,
} from './cel-types.js';
import { checkContracts, checkContractTypes, type Contract } from './contracts.js';

// -- Types --------------------------------------------------------------------

/** What an expression is: its CEL, how tightly it binds, and what it gives */
interface Built {
  readonly text: string;
  readonly prec: number;
  readonly type: CelType;
  /** A field selection, so `has()` can take it */
  readonly field: boolean;
}

/** Anything the builder makes. `T` is what it gives, for types only */
export interface CelExpr<T = unknown> {
  readonly '~cel': Built;
  readonly '~t'?: T;
}

/** A number CEL holds as an int: a size, a count, a `seq`. A body's numbers are doubles */
export type CelInt = number & { readonly '~int': true };
/** A cited version whose body is `B`, as an element of a list */
export interface Cited<B> {
  readonly '~cited': B;
}
/** A link, as `links` holds it */
interface LinkValue {
  readonly rel: string;
  readonly to: string;
}

type Literal = string | number | boolean | null;
type Operand = Literal | CelExpr | ReadonlyArray<Literal | CelExpr>;
type BoolLike = boolean | BoolExpr | DynExpr;
type NumberLike = number | NumExpr | IntExpr | DynExpr;
type StringLike<S extends string = string> = S | StrExpr<S> | DynExpr;
type TypeOf<R> = R extends CelExpr<infer T> ? T : unknown;

/** The expression for a value of type `T` */
export type Expr<T> = 0 extends 1 & T
  ? DynExpr
  : unknown extends T
    ? DynExpr
    : [NonNullable<T>] extends [never]
      ? DynExpr
      : [NonNullable<T>] extends [CelInt]
        ? IntExpr
        : [NonNullable<T>] extends [number]
          ? NumExpr
          : [NonNullable<T>] extends [string]
            ? StrExpr<NonNullable<T> & string>
            : [NonNullable<T>] extends [boolean]
              ? BoolExpr
              : [NonNullable<T>] extends [Cited<infer B>]
                ? VersionExpr<B>
                : [NonNullable<T>] extends [ReadonlyArray<infer E>]
                  ? ListExpr<E>
                  : [NonNullable<T>] extends [object]
                    ? ObjExpr<NonNullable<T>>
                    : DynExpr;

export interface BoolExpr extends CelExpr<boolean> {
  and(...others: BoolLike[]): BoolExpr;
  or(...others: BoolLike[]): BoolExpr;
  not(): BoolExpr;
  eq(other: BoolLike | null): BoolExpr;
  ne(other: BoolLike | null): BoolExpr;
}

interface Ordered<O> {
  eq(other: O | null): BoolExpr;
  ne(other: O | null): BoolExpr;
  lt(other: O): BoolExpr;
  lte(other: O): BoolExpr;
  gt(other: O): BoolExpr;
  gte(other: O): BoolExpr;
}

/** A double: every number read from a body */
export interface NumExpr extends CelExpr<number>, Ordered<NumberLike> {
  in(list: ListExpr<number> | ReadonlyArray<NumberLike> | DynExpr): BoolExpr;
  add(other: number | NumExpr | DynExpr): NumExpr;
  sub(other: number | NumExpr | DynExpr): NumExpr;
  mul(other: number | NumExpr | DynExpr): NumExpr;
  div(other: number | NumExpr | DynExpr): NumExpr;
  neg(): NumExpr;
  /** `int(x)`, toward zero */
  toInt(): IntExpr;
}

/** An int: a size, a count, a `seq` */
export interface IntExpr extends CelExpr<CelInt>, Ordered<NumberLike> {
  in(list: ListExpr<number> | ReadonlyArray<NumberLike> | DynExpr): BoolExpr;
  add(other: number | IntExpr | DynExpr): IntExpr;
  sub(other: number | IntExpr | DynExpr): IntExpr;
  mul(other: number | IntExpr | DynExpr): IntExpr;
  div(other: number | IntExpr | DynExpr): IntExpr;
  mod(other: number | IntExpr | DynExpr): IntExpr;
  neg(): IntExpr;
  /** `double(x)` */
  toDouble(): NumExpr;
}

export interface StrExpr<S extends string = string> extends CelExpr<S>, Ordered<StringLike<S>> {
  in(list: ListExpr<string> | ReadonlyArray<StringLike> | DynExpr): BoolExpr;
  /** In code points */
  size(): IntExpr;
  contains(part: StringLike): BoolExpr;
  startsWith(part: StringLike): BoolExpr;
  endsWith(part: StringLike): BoolExpr;
  add(other: StringLike): StrExpr;
}

export interface ListExpr<E> extends CelExpr<ReadonlyArray<E>> {
  size(): IntExpr;
  /** The same as `size()` */
  count(): IntExpr;
  /** CEL's `filter` */
  where(keep: (item: Expr<E>) => BoolLike): ListExpr<E>;
  filter(keep: (item: Expr<E>) => BoolLike): ListExpr<E>;
  map<R extends CelExpr>(to: (item: Expr<E>) => R): ListExpr<TypeOf<R>>;
  all(test: (item: Expr<E>) => BoolLike): BoolExpr;
  exists(test: (item: Expr<E>) => BoolLike): BoolExpr;
  existsOne(test: (item: Expr<E>) => BoolLike): BoolExpr;
  distinct(): ListExpr<E>;
  /** `item in list` */
  includes(item: Literal | CelExpr): BoolExpr;
  at(index: number | IntExpr): Expr<E>;
  /** `sum(list)`: of numbers only. `0.0` for an empty list, so a sum of ints is untyped */
  sum(
    ..._numbersOnly: [E] extends [number] ? [] : unknown extends E ? [] : [never]
  ): [E] extends [CelInt] ? DynExpr : Expr<E>;
  /**
   * Cited versions, typed as versions of `collection`. A promise, not a
   * check: test `collection` in the contract too.
   */
  of<C extends Schematic>(
    collection: C,
    ..._versionsOnly: [E] extends [Cited<unknown>] ? [] : [never]
  ): ListExpr<Cited<BodyIn<C>>>;
}

/** A map with known fields: a body, or an object in one */
export type ObjExpr<T> = CelExpr<T> & { readonly [K in keyof T & string]-?: Expr<T[K]> };

/** A version: the one before, or one cited */
export interface VersionExpr<B> extends CelExpr<Cited<B>> {
  readonly id: StrExpr;
  readonly key: StrExpr;
  readonly collection: StrExpr;
  readonly seq: IntExpr;
  /** Its account */
  readonly author: StrExpr;
  readonly createdAt: StrExpr;
  readonly deleted: BoolExpr;
  readonly body: Expr<B>;
  readonly links: ListExpr<LinkValue>;
  /** `v.link(rel)`: what its first link with that role points at, or null */
  link(rel: string): StrExpr;
  /** Typed as a version of `collection`. A promise, not a check */
  of<C extends Schematic>(collection: C): VersionExpr<BodyIn<C>>;
  /** `prev == null`: the version before, on a first version */
  eq(other: null): BoolExpr;
  ne(other: null): BoolExpr;
}

/**
 * A value whose type no schema says: a cited version's body, until `.of()`
 * types it. Its methods are typed; any other name reads a field as `any`,
 * since nothing says what it holds. `.get(name)` reads one typed as this.
 */
export interface DynExpr extends CelExpr<unknown> {
  eq(other: Operand): BoolExpr;
  ne(other: Operand): BoolExpr;
  lt(other: Operand): BoolExpr;
  lte(other: Operand): BoolExpr;
  gt(other: Operand): BoolExpr;
  gte(other: Operand): BoolExpr;
  in(list: Operand): BoolExpr;
  and(...others: BoolLike[]): BoolExpr;
  or(...others: BoolLike[]): BoolExpr;
  not(): BoolExpr;
  add(other: Operand): DynExpr;
  sub(other: Operand): DynExpr;
  mul(other: Operand): DynExpr;
  div(other: Operand): DynExpr;
  mod(other: Operand): DynExpr;
  neg(): DynExpr;
  size(): IntExpr;
  count(): IntExpr;
  contains(part: StringLike): BoolExpr;
  startsWith(part: StringLike): BoolExpr;
  endsWith(part: StringLike): BoolExpr;
  where(keep: (item: DynExpr) => BoolLike): DynExpr;
  filter(keep: (item: DynExpr) => BoolLike): DynExpr;
  map<R extends CelExpr>(to: (item: DynExpr) => R): ListExpr<TypeOf<R>>;
  all(test: (item: DynExpr) => BoolLike): BoolExpr;
  exists(test: (item: DynExpr) => BoolLike): BoolExpr;
  existsOne(test: (item: DynExpr) => BoolLike): BoolExpr;
  distinct(): DynExpr;
  sum(): DynExpr;
  includes(item: Literal | CelExpr): BoolExpr;
  at(index: Operand): DynExpr;
  /** A field, typed as a value of no known type: also one named like a method */
  get(field: string): DynExpr;
  link(rel: string): StrExpr;
  toInt(): IntExpr;
  toDouble(): NumExpr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a field of a value no schema describes; an index signature typed otherwise would be possibly undefined
  readonly [field: string]: any;
}

/** Something with a body type: a collection definition, a validator, JSON Schema, or a `Typed` name */
type Schematic = object;
type BodyIn<C> = C extends { readonly '~standard': unknown } ? BodyOf<{ readonly schema: C }> : BodyOf<C>;

/** What a contract reads (spec 09 §5.2), and the functions it calls */
export interface ContractContext<B> {
  readonly body: Expr<B>;
  /** The version before, or null on a first version: `prev.eq(null)` */
  readonly prev: VersionExpr<B>;
  readonly links: ListExpr<LinkValue>;
  readonly key: StrExpr;
  readonly seq: IntExpr;
  readonly collection: StrExpr;
  /** The writer's account */
  readonly author: StrExpr;
  /** The account that wrote the record's first version */
  readonly creator: StrExpr;
  readonly createdAt: StrExpr;
  /** The versions cited by these ids, in order: generic until narrowed with `.of(collection)` */
  readonly versions: (
    ids: ListExpr<string> | ReadonlyArray<StringLike> | DynExpr,
  ) => ListExpr<Cited<unknown>>;
  /** What this version's first link with that role points at, or null */
  readonly link: (rel: string) => StrExpr;
  /** Whether an account is a member, as of this version */
  readonly member: (did: StringLike) => BoolExpr;
  readonly hash: (value: Operand) => StrExpr;
  /** `has(body.note)`: whether a field is there */
  readonly has: (field: CelExpr) => BoolExpr;
  /** `test ? then : otherwise` */
  readonly when: <R extends CelExpr>(test: BoolLike, then: R | Literal, otherwise: R | Literal) => R;
  /** CEL written by hand, for what the builder doesn't cover. Its type is yours to say */
  readonly raw: <T = unknown>(cel: string) => Expr<T>;
}

// -- Text ---------------------------------------------------------------------

// How tightly each form binds, as CEL's grammar nests them.
const COND = 1;
const OR = 2;
const AND = 3;
const REL = 4;
const ADD = 5;
const MUL = 6;
const UNARY = 7;
const MEMBER = 8;

const wrap = (b: Built, min: number) => (b.prec >= min ? b.text : `(${b.text})`);
const built = (text: string, prec: number, type: CelType, field = false): Built =>
  Object.freeze({ text, prec, type, field });

/** A string as a CEL literal */
function quote(s: string): string {
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s))
    throw new Error('a contract string has a lone surrogate');
  // eslint-disable-next-line no-control-regex -- control characters are what it escapes
  return `"${s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) =>
    c === '\\' || c === '"' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}"`;
}

/** A number as a CEL literal of the kind `hint` asks for: an int next to an int, else a double */
function numberText(n: number, hint: CelType): string {
  if (!Number.isFinite(n)) throw new Error(`a contract can't hold ${n}`);
  if (hint.t === 'int' || hint.t === 'uint') {
    if (!Number.isSafeInteger(n)) throw new Error(`${n} is used as an int, and is not one`);
    return `${n}${hint.t === 'uint' ? 'u' : ''}`;
  }
  const s = String(n);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

function isExpr(x: unknown): x is CelExpr {
  return (typeof x === 'object' || typeof x === 'function') && x !== null && '~cel' in x;
}

/** A value as an expression: one built already, or a literal of the kind `hint` asks for */
function operand(x: unknown, hint: CelType): Built {
  if (isExpr(x)) return x['~cel'];
  if (x === null) return built('null', MEMBER, DYN);
  if (typeof x === 'boolean') return built(String(x), MEMBER, BOOL);
  if (typeof x === 'string') return built(quote(x), MEMBER, STRING);
  if (typeof x === 'number') {
    const kind = hint.t === 'int' || hint.t === 'uint' ? hint : DOUBLE;
    return built(numberText(x, kind), x < 0 || Object.is(x, -0) ? UNARY : MEMBER, kind);
  }
  if (Array.isArray(x)) {
    const item = hint.t === 'list' ? hint.item : DYN;
    const items = x.map((i: unknown) => operand(i, item));
    const first = items[0]?.type;
    const same = first && items.every((i) => i.type.t === first.t) ? first : item;
    return built(`[${items.map((i) => i.text).join(', ')}]`, MEMBER, listOf(same));
  }
  throw new Error(`a contract can't hold ${typeof x === 'object' ? 'an object' : typeof x}: use raw()`);
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUOTED = /^[A-Za-z0-9_.\-/ ]+$/;

function select(on: Built, name: string, type: CelType): unknown {
  if (FIELD.test(name)) return expr(built(`${wrap(on, MEMBER)}.${name}`, MEMBER, type, true));
  if (QUOTED.test(name)) return expr(built(`${wrap(on, MEMBER)}.\`${name}\``, MEMBER, type, true));
  return expr(built(`${wrap(on, MEMBER)}[${quote(name)}]`, MEMBER, type));
}

// -- Expressions ----------------------------------------------------------------

/** Each macro's variable is named for how deep it is, so an inner one never hides an outer one */
let depth = 0;

/** The expression object for what was built: fields for a map, methods for anything else */
function expr(b: Built): unknown {
  const t = b.type;
  if (t.t === 'object' && t.version) return version(b, t.fields);
  if (t.t === 'object') {
    const { fields, strict, others } = t;
    return new Proxy(Object.freeze({ '~cel': b }), {
      get(target, prop) {
        if (prop === '~cel') return target['~cel'];
        if (typeof prop !== 'string') return undefined;
        const field = Object.hasOwn(fields, prop) ? fields[prop] : undefined;
        if (field) return select(b, prop, field);
        // Not a declared field: `then` stays undefined, so the proxy is never taken for a promise.
        return strict || prop === 'then' ? undefined : select(b, prop, others ?? DYN);
      },
    });
  }
  const methods = Object.freeze(valueMethods(b));
  if (t.t !== 'dyn') return methods;
  // A value of no known type: any name that is not a method reads a field.
  return new Proxy(methods, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (Object.hasOwn(target, prop)) return target[prop];
      return prop === 'then' ? undefined : select(b, prop, DYN);
    },
  });
}

function version(b: Built, fields: Readonly<Record<string, CelType>>): unknown {
  const out: Record<string, unknown> = { '~cel': b };
  for (const [name, type] of Object.entries(fields)) out[name] = select(b, name, type);
  out.link = (rel: unknown) => method(b, 'link', [operand(rel, STRING)], STRING);
  out.of = (collection: unknown) => expr(built(b.text, b.prec, versionType(bodyType(collection)), b.field));
  out.eq = (other: unknown) => binary(b, '==', operand(other, DYN), REL, BOOL);
  out.ne = (other: unknown) => binary(b, '!=', operand(other, DYN), REL, BOOL);
  return Object.freeze(out);
}

function binary(l: Built, op: string, r: Built, prec: number, type: CelType): unknown {
  return expr(built(`${wrap(l, prec)} ${op} ${wrap(r, prec + 1)}`, prec, type));
}

function method(target: Built, name: string, args: ReadonlyArray<Built>, type: CelType): unknown {
  return expr(built(`${wrap(target, MEMBER)}.${name}(${args.map((a) => a.text).join(', ')})`, MEMBER, type));
}

function call(name: string, args: ReadonlyArray<Built>, type: CelType): unknown {
  return expr(built(`${name}(${args.map((a) => a.text).join(', ')})`, MEMBER, type));
}

/** `&&` or `||` over all of these, as one chain */
function chain(items: ReadonlyArray<Built>, op: '&&' | '||'): unknown {
  const prec = op === '&&' ? AND : OR;
  return expr(built(items.map((i) => wrap(i, prec)).join(` ${op} `), prec, BOOL));
}

const itemOf = (t: CelType): CelType => (t.t === 'list' ? t.item : t.t === 'object' ? STRING : DYN);

const isFunction = (x: unknown): x is (item: unknown) => unknown => typeof x === 'function';

/** A macro, its body built with a variable of the list's item type */
function macro(on: Built, name: string, fn: unknown, type: (out: CelType) => CelType): unknown {
  if (!isFunction(fn)) throw new Error(`${name}() takes a function`);
  const v = `x${depth}`;
  depth++;
  let out: Built;
  try {
    out = operand(fn(expr(built(v, MEMBER, itemOf(on.type)))), BOOL);
  } finally {
    depth--;
  }
  return expr(built(`${wrap(on, MEMBER)}.${name}(${v}, ${out.text})`, MEMBER, type(out.type)));
}

/** The type of what arithmetic gives: the side whose type is known */
const arithmetic = (l: Built, r: Built) => (l.type.t === 'dyn' ? r.type : l.type);

function valueMethods(b: Built): Record<string, unknown> {
  const t = b.type;
  const rel = (op: string) => (other: unknown) => binary(b, op, operand(other, t), REL, BOOL);
  const add = (op: string) => (other: unknown) => {
    const r = operand(other, t);
    return binary(b, op, r, op === '+' || op === '-' ? ADD : MUL, arithmetic(b, r));
  };
  const item = t.t === 'list' ? t.item : DYN;
  const list = t.t === 'list' ? t : listOf(DYN);
  const filter = (keep: unknown) => macro(b, 'filter', keep, () => list);
  return {
    '~cel': b,
    eq: rel('=='),
    ne: rel('!='),
    lt: rel('<'),
    lte: rel('<='),
    gt: rel('>'),
    gte: rel('>='),
    in: (items: unknown) => binary(b, 'in', operand(items, listOf(t)), REL, BOOL),
    and: (...others: unknown[]) => chain([b, ...others.map((o) => operand(o, BOOL))], '&&'),
    or: (...others: unknown[]) => chain([b, ...others.map((o) => operand(o, BOOL))], '||'),
    not: () => expr(built(`!${wrap(b, MEMBER)}`, UNARY, BOOL)),
    add: add('+'),
    sub: add('-'),
    mul: add('*'),
    div: add('/'),
    mod: add('%'),
    neg: () => expr(built(`-${wrap(b, MEMBER)}`, UNARY, t)),
    size: () => method(b, 'size', [], INT),
    count: () => method(b, 'size', [], INT),
    contains: (part: unknown) => method(b, 'contains', [operand(part, STRING)], BOOL),
    startsWith: (part: unknown) => method(b, 'startsWith', [operand(part, STRING)], BOOL),
    endsWith: (part: unknown) => method(b, 'endsWith', [operand(part, STRING)], BOOL),
    where: filter,
    filter,
    map: (to: unknown) => macro(b, 'map', to, listOf),
    all: (test: unknown) => macro(b, 'all', test, () => BOOL),
    exists: (test: unknown) => macro(b, 'exists', test, () => BOOL),
    existsOne: (test: unknown) => macro(b, 'exists_one', test, () => BOOL),
    distinct: () => method(b, 'distinct', [], list),
    // `sum([])` is `0.0`, so a sum of ints is an int or a double.
    sum: () => call('sum', [b], item.t === 'double' ? DOUBLE : DYN),
    includes: (x: unknown) => binary(operand(x, item), 'in', b, REL, BOOL),
    at: (index: unknown) => expr(built(`${wrap(b, MEMBER)}[${operand(index, INT).text}]`, MEMBER, item)),
    of: (collection: unknown) =>
      expr(built(b.text, b.prec, listOf(versionType(bodyType(collection))), b.field)),
    get: (field: unknown) => select(b, String(field), DYN),
    link: (rel: unknown) => method(b, 'link', [operand(rel, STRING)], STRING),
    toInt: () => call('int', [b], INT),
    toDouble: () => call('double', [b], DOUBLE),
  };
}

// -- Contracts ------------------------------------------------------------------

/** The JSON Schema of a definition, a validator or JSON Schema itself; undefined when it has none */
function schemaOf(x: unknown): unknown {
  const schema = isObject(x) && 'schema' in x && !('~standard' in x) ? x.schema : x;
  if (!isObject(schema)) return undefined;
  try {
    return toJsonSchema(schema);
  } catch {
    return undefined;
  }
}

const bodyType = (x: unknown) => typeOfSchema(schemaOf(x));

function context(body: CelType): Record<string, unknown> {
  const name = (n: string, type: CelType) => expr(built(n, MEMBER, type));
  const self = versionType(body);
  const fields = self.t === 'object' ? self.fields : {};
  return {
    body: name('body', body),
    prev: name('prev', self),
    links: name('links', fields.links ?? DYN),
    key: name('key', STRING),
    seq: name('seq', INT),
    collection: name('collection', STRING),
    author: name('author', STRING),
    creator: name('creator', STRING),
    createdAt: name('createdAt', STRING),
    versions: (ids: unknown) => call('versions', [operand(ids, listOf(STRING))], listOf(versionType(DYN))),
    link: (rel: unknown) => call('link', [operand(rel, STRING)], STRING),
    member: (did: unknown) => call('member', [operand(did, STRING)], BOOL),
    hash: (value: unknown) => call('hash', [operand(value, DYN)], STRING),
    has: (field: unknown) => {
      const f = operand(field, DYN);
      if (!f.field) throw new Error('has() takes a field, like body.note');
      return expr(built(`has(${f.text})`, MEMBER, BOOL));
    },
    when: (test: unknown, then: unknown, otherwise: unknown) => {
      const hint = isExpr(then) ? then['~cel'].type : isExpr(otherwise) ? otherwise['~cel'].type : DYN;
      const a = operand(then, hint);
      const c = operand(otherwise, hint);
      const type = a.type.t === c.type.t ? a.type : hint;
      return expr(built(`${wrap(operand(test, BOOL), OR)} ? ${wrap(a, OR)} : ${wrap(c, COND)}`, COND, type));
    },
    raw: (cel: unknown) => {
      if (typeof cel !== 'string') throw new Error('raw() takes CEL as a string');
      return expr(built(cel, 0, DYN));
    },
  };
}

/**
 * One condition of a contract, built in TypeScript: `body` is typed from
 * `schema` (a collection definition, a validator, or JSON Schema), and the
 * result is the `{ that, else }` a definition's `contract.check` holds.
 *
 * ```ts
 * const famous = contract(Fame, ({ body, versions, link }) =>
 *   versions(body.reactions)
 *     .where((r) => r.collection.eq('app.reaction').and(r.link('on').eq(link('on'))))
 *     .map((r) => r.author)
 *     .distinct()
 *     .count()
 *     .gte(5),
 *   'Needs five different people',
 * );
 * ```
 *
 * Throws when what it builds is not a condition the library would define.
 */
export function contract<C extends Schematic>(
  schema: C,
  that: (scope: ContractContext<BodyIn<C>>) => BoolLike,
  why: string,
): Contract {
  const json = schemaOf(schema);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- made at run time to match these types, from the same schema
  const scope = context(typeOfSchema(json)) as unknown as ContractContext<BodyIn<C>>;
  depth = 0;
  const made: Contract = Object.freeze({ that: operand(that(scope), BOOL).text, else: why });
  const problem = checkContracts([made], 'contract') ?? checkContractTypes([made], json, 'contract');
  if (problem) throw new Error(`${problem}\n  in: ${made.that}`);
  return made;
}
