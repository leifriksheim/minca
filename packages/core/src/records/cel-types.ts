/**
 * Types for contracts, worked out from a collection's JSON Schema: what the
 * library checks when a collection is defined, so a misspelled field or a
 * comparison of a string with a number is refused where its author can fix
 * it. Not protocol: peers never run this, and a definition it would refuse
 * still stands when another writer stores it (spec 09 §8).
 *
 * It refuses what is wrong for every body the schema allows, with one rule
 * stricter than JSON Schema: a field an object doesn't declare is taken for
 * a typo unless the object says other fields may be there
 * (`additionalProperties` other than `false`; absent counts as closed, as a
 * Zod object writes it). Anything read from a cited version's body, a schema
 * it can't follow, or `dyn(x)` is `dyn`, and passes. What it can't catch: a missing optional field (that is
 * `has()`'s job), a cited version of the wrong collection, values out of
 * range, and anything a `dyn` hides.
 */
import { isObject } from '../utils/guards.js';
import { isCelError, isMap, isUint, type CelNode, type CelValue } from './cel.js';

/** What a part of an expression gives, as far as the schema says */
export type CelType =
  | { readonly t: 'dyn' }
  | { readonly t: 'null' | 'bool' | 'int' | 'uint' | 'double' | 'string' }
  | { readonly t: 'list'; readonly item: CelType }
  /** A map with known fields. `strict`: a field it doesn't name is a mistake. `version`: a cited version */
  | {
      readonly t: 'object';
      readonly fields: Readonly<Record<string, CelType>>;
      readonly strict: boolean;
      /** The type of a field it doesn't name, when its schema says */
      readonly others?: CelType;
      readonly version?: true;
    };

export const DYN: CelType = Object.freeze({ t: 'dyn' });
const scalar = (t: 'null' | 'bool' | 'int' | 'uint' | 'double' | 'string'): CelType => Object.freeze({ t });
export const STRING = scalar('string');
export const INT = scalar('int');
export const DOUBLE = scalar('double');
export const BOOL = scalar('bool');
const NULL = scalar('null');
const UINT = scalar('uint');
export const listOf = (item: CelType): CelType => Object.freeze({ t: 'list', item });

const LINK: CelType = Object.freeze({
  t: 'object',
  fields: Object.freeze({ rel: STRING, to: STRING }),
  strict: true,
});

/** A version as a contract reads it (spec 09 §6.1), with its body's type */
export function versionType(body: CelType): CelType {
  return Object.freeze({
    t: 'object',
    strict: true,
    version: true,
    fields: Object.freeze({
      id: STRING,
      key: STRING,
      collection: STRING,
      seq: INT,
      author: STRING,
      createdAt: STRING,
      deleted: BOOL,
      body,
      links: listOf(LINK),
    }),
  });
}

/**
 * A JSON Schema's type, as CEL reads a value it allows: every number is a
 * `double`, an object with `properties` has those fields, and anything it
 * can't pin to one type is `dyn`. An object is strict unless it says
 * `additionalProperties: true`.
 */
export function typeOfSchema(schema: unknown): CelType {
  if (!isObject(schema)) return DYN;
  if ('const' in schema) return typeOfJson(schema.const);
  if (Array.isArray(schema.enum)) return same(schema.enum.map(typeOfJson));
  const choices = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (choices) return same(choices.map(typeOfSchema).filter((t) => t.t !== 'null'));
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t) => t !== 'null');
  if (types.length !== 1) return DYN;
  switch (types[0]) {
    case 'string':
      return STRING;
    case 'number':
    case 'integer':
      return DOUBLE;
    case 'boolean':
      return BOOL;
    case 'array':
      return listOf(typeOfSchema(schema.items));
    case 'object': {
      if (!isObject(schema.properties)) return DYN;
      const fields: Record<string, CelType> = {};
      for (const [name, field] of Object.entries(schema.properties)) fields[name] = typeOfSchema(field);
      const others = schema.additionalProperties;
      return Object.freeze({
        t: 'object',
        fields: Object.freeze(fields),
        strict: others === undefined || others === false,
        // Fields it doesn't name: of the type `additionalProperties` gives, when it is a schema.
        ...(isObject(others) ? { others: typeOfSchema(others) } : {}),
      });
    }
    default:
      return DYN;
  }
}

/** The one type all of these are, or dyn */
function same(types: ReadonlyArray<CelType>): CelType {
  const first = types[0];
  if (!first || first.t === 'list' || first.t === 'object') return DYN;
  return types.every((t) => t.t === first.t) ? first : DYN;
}

function typeOfJson(value: unknown): CelType {
  if (value === null) return NULL;
  if (typeof value === 'string') return STRING;
  if (typeof value === 'number') return DOUBLE;
  if (typeof value === 'boolean') return BOOL;
  return DYN;
}

function typeOfLiteral(v: CelValue): CelType {
  if (v === null) return NULL;
  if (typeof v === 'boolean') return BOOL;
  if (typeof v === 'bigint') return INT;
  if (typeof v === 'number') return DOUBLE;
  if (typeof v === 'string') return STRING;
  if (Array.isArray(v) || isCelError(v) || isMap(v)) return DYN;
  return isUint(v) ? UINT : DYN;
}

const NUMERIC = new Set(['int', 'uint', 'double']);
const known = (t: CelType) => t.t !== 'dyn';
/** What a type is called in a message */
const named = (t: CelType): string =>
  t.t === 'list' ? 'a list' : t.t === 'object' ? 'a map' : t.t === 'int' ? 'an int' : `a ${t.t}`;
/** Kinds `==` can find equal: numbers of any kind are one */
const family = (t: CelType) => (NUMERIC.has(t.t) ? 'number' : t.t);

/** Short text for a part, for messages: `body.amount`, or `…` */
function shown(n: CelNode): string {
  if (n.k === 'ident') return n.name;
  if (n.k === 'select') return `${shown(n.on)}.${n.field}`;
  if (n.k === 'call' && n.target) return `${shown(n.target)}.${n.fn}()`;
  if (n.k === 'call' && /^[a-z]/.test(n.fn)) return `${n.fn}()`;
  if (n.k === 'lit' && typeof n.v === 'string') return JSON.stringify(n.v);
  if (n.k === 'lit' && (n.v === null || typeof n.v !== 'object')) return String(n.v);
  return '…';
}

/** Thrown inside the walk: the first mistake found */
const mistake = (message: string) => Object.assign(new Error(message), { celType: true });
const isMistake = (e: unknown): e is Error => e instanceof Error && 'celType' in e;

/**
 * The first mistake in a parsed condition, judged against what its names
 * hold (`body`'s type, from the collection's schema), or null. Run only on a
 * condition `checkCel` accepted.
 */
export function typeCheckCel(
  node: CelNode,
  names: ReadonlyMap<string, CelType>,
  options: {
    /** What `linked(collection, rel)` finds the bodies of, or why it can't: for computed fields */
    readonly linked?: LinkedBodies;
    /** Any value, not only a bool: a computed field's */
    readonly anything?: boolean;
  } = {},
): string | null {
  const result = typeOfCel(node, names, options.linked);
  if (typeof result === 'string') return result;
  if (!options.anything && known(result) && result.t !== 'bool')
    return `gives ${named(result)}, so it is never true: a condition must give a bool`;
  return null;
}

/** The body type of what `linked(collection, rel)` finds, or why that can't link here */
export type LinkedBodies = (collection: string, rel: string) => CelType | string;

/** The type a whole expression gives, or a mistake in it: what a computed field holds */
export function typeOfCel(
  node: CelNode,
  names: ReadonlyMap<string, CelType>,
  linked?: LinkedBodies,
): CelType | string {
  try {
    return typeOf(node, names, linked);
  } catch (error) {
    if (isMistake(error)) return error.message;
    throw error;
  }
}

function fail(message: string): never {
  throw mistake(message);
}

function bool(n: CelNode, t: CelType, what: string) {
  if (known(t) && t.t !== 'bool') fail(`${what} takes a bool, and ${shown(n)} is ${named(t)}`);
}

function equatable(a: CelType, b: CelType, an: CelNode, bn: CelNode) {
  if (!known(a) || !known(b) || a.t === 'null' || b.t === 'null') return;
  if (family(a) !== family(b))
    fail(`compares ${shown(an)}, ${named(a)}, with ${shown(bn)}, ${named(b)}: never equal`);
}

function typeOf(n: CelNode, names: ReadonlyMap<string, CelType>, linked?: LinkedBodies): CelType {
  const of = (child: CelNode) => typeOf(child, names, linked);
  switch (n.k) {
    case 'lit':
      return typeOfLiteral(n.v);
    case 'ident':
      return names.get(n.name) ?? DYN;
    case 'select': {
      const on = of(n.on);
      if (!known(on) || on.t === 'null') return n.test ? BOOL : DYN;
      if (on.t !== 'object') fail(`${shown(n)} reads a field of ${shown(n.on)}, which is ${named(on)}`);
      const field = Object.hasOwn(on.fields, n.field) ? on.fields[n.field] : undefined;
      if (field === undefined && on.strict) {
        const has = Object.keys(on.fields);
        fail(
          `${shown(n)}: ${shown(n.on)} has no field "${n.field}"` +
            (has.length ? ` (it has ${has.join(', ')})` : ''),
        );
      }
      return n.test ? BOOL : (field ?? on.others ?? DYN);
    }
    case 'index': {
      const on = of(n.on);
      const at = of(n.at);
      if (on.t === 'list') {
        if (known(at) && !NUMERIC.has(at.t)) fail(`${shown(n.on)} is a list, indexed by ${named(at)}`);
        return on.item;
      }
      if (known(on) && on.t !== 'object') fail(`${shown(n.on)} is ${named(on)}, which can't be indexed`);
      if (on.t === 'object' && n.at.k === 'lit' && typeof n.at.v === 'string')
        return (Object.hasOwn(on.fields, n.at.v) ? on.fields[n.at.v] : undefined) ?? DYN;
      return DYN;
    }
    case 'list': {
      const items = n.items.map(of);
      const first = items[0];
      return listOf(
        first && items.every((t) => t.t === first.t && t.t !== 'list' && t.t !== 'object') ? first : DYN,
      );
    }
    case 'map':
      for (const [k, v] of n.entries) {
        of(k);
        of(v);
      }
      return DYN;
    case 'cond': {
      bool(n.test, of(n.test), '? :');
      const a = of(n.then);
      const b = of(n.else);
      if (a.t === 'null') return b;
      if (b.t === 'null') return a;
      return a.t === b.t && a.t !== 'list' && a.t !== 'object' ? a : DYN;
    }
    case 'and':
    case 'or': {
      // A side that decides lets an error on another pass, so only all sides known and none a bool is wrong.
      const types = n.items.map(of);
      if (types.every((t) => known(t) && t.t !== 'bool'))
        bool(n.items[0]!, types[0]!, n.k === 'and' ? '&&' : '||');
      return BOOL;
    }
    case 'comp': {
      const range = of(n.range);
      let item: CelType = DYN;
      if (range.t === 'list') item = range.item;
      else if (range.t === 'object') item = STRING;
      else if (known(range) && range.t !== 'null')
        fail(`${n.macro}() goes through a list or a map, and ${shown(n.range)} is ${named(range)}`);
      const inner = new Map(names).set(n.v, item);
      if (n.pred) bool(n.pred, typeOf(n.pred, inner, linked), `${n.macro}()`);
      if (n.macro === 'map') return listOf(n.out ? typeOf(n.out, inner, linked) : DYN);
      if (n.macro === 'filter') return range.t === 'list' ? range : listOf(item);
      return BOOL;
    }
    case 'call':
      return callType(n, of, linked);
  }
}

function callType(
  n: Extract<CelNode, { k: 'call' }>,
  of: (n: CelNode) => CelType,
  linkedBodies: LinkedBodies | undefined,
): CelType {
  if (n.target?.k === 'ident' && n.target.name === 'math') {
    const args = n.args.map(of);
    const first = args[0];
    if (args.length === 1 && first?.t === 'list') return NUMERIC.has(first.item.t) ? first.item : DYN;
    return first && NUMERIC.has(first.t) && args.every((t) => t.t === first.t) ? first : DYN;
  }
  const target = n.target ? of(n.target) : null;
  const args = n.args.map(of);
  const [a = DYN, b = DYN] = args;
  const [an, bn] = [n.args[0]!, n.args[1]!];
  const ordered = (x: CelType) => NUMERIC.has(x.t) || x.t === 'string' || x.t === 'bool';
  if (target) {
    const tn = n.target!;
    switch (n.fn) {
      case 'size':
        if (known(target) && !['string', 'list', 'object'].includes(target.t))
          fail(`${shown(n)}: ${shown(tn)} is ${named(target)}, which has no size`);
        return INT;
      case 'contains':
      case 'startsWith':
      case 'endsWith':
        if (known(target) && target.t !== 'string')
          fail(`${shown(n)}: ${n.fn}() is for strings, and ${shown(tn)} is ${named(target)}`);
        if (known(a) && a.t !== 'string') fail(`${shown(n)} takes a string, and ${shown(an)} is ${named(a)}`);
        return BOOL;
      case 'distinct':
        if (known(target) && target.t !== 'list')
          fail(`${shown(n)}: distinct() is for lists, and ${shown(tn)} is ${named(target)}`);
        return target.t === 'list' ? target : listOf(DYN);
      case 'link':
        if (known(target) && target.t !== 'object')
          fail(`${shown(n)}: link() is for versions, and ${shown(tn)} is ${named(target)}`);
        return STRING;
    }
    return DYN;
  }
  switch (n.fn) {
    case '==':
    case '!=':
      equatable(a, b, an, bn);
      return BOOL;
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (known(a) && known(b) && !(ordered(a) && family(a) === family(b)))
        fail(`compares ${shown(an)}, ${named(a)}, with ${shown(bn)}, ${named(b)}, by order: an error`);
      return BOOL;
    case 'in':
      if (b.t === 'list') equatable(a, b.item, an, bn);
      else if (known(b) && b.t !== 'object')
        fail(`"in" looks in a list or a map, and ${shown(bn)} is ${named(b)}`);
      return BOOL;
    case '+':
    case '-':
    case '*':
    case '/':
    case '%': {
      if (!known(a) || !known(b)) return DYN;
      const can =
        n.fn === '+'
          ? ['int', 'uint', 'double', 'string', 'list']
          : n.fn === '%'
            ? ['int', 'uint']
            : ['int', 'uint', 'double'];
      if (a.t !== b.t || !can.includes(a.t)) {
        const hint =
          NUMERIC.has(a.t) && NUMERIC.has(b.t)
            ? `: a body's numbers are doubles, so write 1.0 for 1, or convert with int() or double()`
            : '';
        fail(`${shown(an)} ${n.fn} ${shown(bn)} mixes ${named(a)} and ${named(b)}, an error${hint}`);
      }
      return a;
    }
    case '!':
      bool(an, a, '!');
      return BOOL;
    case 'neg':
      if (known(a) && a.t !== 'int' && a.t !== 'double') fail(`-${shown(an)}: ${named(a)} can't be negated`);
      return a;
    case 'size':
      if (known(a) && !['string', 'list', 'object'].includes(a.t))
        fail(`size(${shown(an)}): ${named(a)} has no size`);
      return INT;
    case 'int':
      return INT;
    case 'uint':
      return UINT;
    case 'double':
      return DOUBLE;
    case 'string':
    case 'hash':
      return STRING;
    case 'bool':
      return BOOL;
    case 'sum':
      if (known(a) && a.t !== 'list') fail(`sum() adds up a list, and ${shown(an)} is ${named(a)}`);
      if (a.t === 'list' && known(a.item) && !NUMERIC.has(a.item.t))
        fail(
          `sum(${shown(an)}) adds up ${a.item.t === 'list' ? 'list' : a.item.t === 'object' ? 'map' : a.item.t}s, not numbers`,
        );
      // `sum([])` is `0.0`, so a sum of ints is an int or a double.
      return a.t === 'list' && a.item.t === 'double' ? DOUBLE : DYN;
    case 'versions':
      if (known(a) && a.t !== 'list')
        fail(
          `versions() takes a list of ids, and ${shown(an)} is ${named(a)}: write versions([${shown(an)}])`,
        );
      if (a.t === 'list' && known(a.item) && a.item.t !== 'string')
        fail(`versions() takes a list of ids, and ${shown(an)} holds something else`);
      return listOf(versionType(DYN));
    case 'member':
      if (known(a) && a.t !== 'string')
        fail(`member() takes an account's DID, and ${shown(an)} is ${named(a)}`);
      return BOOL;
    case 'linked': {
      const [c, r] = n.args;
      if (
        !linkedBodies ||
        c?.k !== 'lit' ||
        r?.k !== 'lit' ||
        typeof c.v !== 'string' ||
        typeof r.v !== 'string'
      )
        return listOf(versionType(DYN));
      const body = linkedBodies(c.v, r.v);
      if (typeof body === 'string') fail(`${shown(n)}: ${body}`);
      return listOf(versionType(body));
    }
    case 'link':
      return STRING;
  }
  return DYN;
}
