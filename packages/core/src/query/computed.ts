/**
 * Computed fields: values a collection's definition derives from the records
 * a node holds, the same way in every app that reads it. "Done once two
 * people have reacted 👍" is one.
 *
 * Each is a CEL expression, in the language contracts use (spec 09 §5), with
 * one function more: `linked(collection, rel)`, the records that link to this
 * one. That is a search, which a contract may not do, so a computed field is
 * a view, not a verdict: each node derives it from what it holds, and two
 * nodes holding different records read different values until they have
 * synced. Not protocol: peers keep the definition's `computed` member and
 * never read it (packages/core/docs/computed.md).
 */
import type { NodeRecord } from '../node/types.js';
import {
  celChildren,
  checkCel,
  evaluateCel,
  fromJson,
  isCelError,
  isCelStop,
  parseCel,
  toJson,
  MAX_CEL_STEPS,
  MAX_CEL_WORK,
  type CelNode,
  type CelValue,
} from '../records/cel.js';
import { INT, STRING, typeOfCel, typeOfSchema, versionType, type CelType } from '../records/cel-types.js';
import { versionValue } from '../records/contracts.js';
import { LINK_REL_PATTERN } from '../records/links.js';
import { isRecord } from '../utils/guards.js';

/** As stored: each field's CEL, by name */
export type ComputedFields = Readonly<Record<string, string>>;

/** What a record's computed fields hold. A field that can't be computed for it holds null */
export type ComputedValues = Readonly<Record<string, unknown>>;

/** At most this many per collection: each is worked out for every record read */
const MAX_COMPUTED = 16;
/** Characters in one field's expression, as for a contract's condition */
const MAX_LENGTH = 4000;
/** Parts in all of a collection's fields */
const MAX_NODES = 2000;

const NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const COLLECTION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** What a computed field reads of its record */
const NAMES = new Set([
  'body',
  'links',
  'key',
  'seq',
  'collection',
  'author',
  'creator',
  'createdAt',
  'updatedAt',
]);

const parsed = new Map<string, CelNode>();
function parse(source: string): CelNode | string {
  const cached = parsed.get(source);
  if (cached) return cached;
  try {
    const node = parseCel(source);
    if (parsed.size > 1000) parsed.clear();
    parsed.set(source, node);
    return node;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Why a definition's `computed` member can't be used, or null */
export function checkComputed(computed: unknown, at = 'computed'): string | null {
  if (!isRecord(computed)) return `${at} must be an object: each field's name, and its CEL`;
  const entries = Object.entries(computed);
  if (entries.length > MAX_COMPUTED) return `${at}: at most ${MAX_COMPUTED} computed fields`;
  const count = { nodes: 0 };
  for (const [name, source] of entries) {
    const here = `${at}.${name}`;
    if (!NAME.test(name)) return `${here}: a name is lower camel case, like "done" or "thumbsUp"`;
    if (typeof source !== 'string' || !source.trim() || source.length > MAX_LENGTH)
      return `${here} is a CEL expression, at most ${MAX_LENGTH} characters`;
    const node = parse(source);
    if (typeof node === 'string') return `${here}: ${node}`;
    const problem = checkCel(node, { names: NAMES, linked: true, linkRel: LINK_REL_PATTERN }, count);
    if (problem) return `${here}: ${problem}`;
    for (const [collection] of linkedCalls(node)) {
      if (!COLLECTION.test(collection))
        return `${here}: linked() takes a collection name, like "app.reaction"; "${collection}" is not one`;
    }
    if (count.nodes > MAX_NODES) return `${at}: computed fields are too large (at most ${MAX_NODES} parts)`;
  }
  return null;
}

/** Every `linked(collection, rel)` an expression calls */
function linkedCalls(node: CelNode, into: Array<[string, string]> = []): Array<[string, string]> {
  if (node.k === 'call' && !node.target && node.fn === 'linked') {
    const [c, r] = node.args;
    if (c?.k === 'lit' && r?.k === 'lit' && typeof c.v === 'string' && typeof r.v === 'string')
      into.push([c.v, r.v]);
  }
  for (const child of celChildren(node)) linkedCalls(child, into);
  return into;
}

/** What the library knows of a collection another one's computed fields read */
export interface LinkingCollection {
  readonly schema: unknown;
  readonly links?: Readonly<Record<string, { readonly to: '*' | ReadonlyArray<string> }>>;
}

/**
 * Mistakes in computed fields that a checked `computed` member can still
 * hold, found with the schemas: a body field that isn't there, a string
 * compared with a number, a `linked()` of a collection that doesn't declare
 * that link role to this one. Library only, as for contracts' types.
 * `definitionOf` says what the space defines; a `std.*` collection it lacks
 * is read untyped.
 */
export function checkComputedTypes(
  name: string,
  computed: ComputedFields,
  schema: unknown,
  definitionOf: (collection: string) => LinkingCollection | null,
  at = 'computed',
): string | null {
  const types = typesOfComputed(name, computed, schema, definitionOf, at);
  return typeof types === 'string' ? types : null;
}

/** Each computed field's type, worked out against the schemas, or why one can't be */
function typesOfComputed(
  name: string,
  computed: ComputedFields,
  schema: unknown,
  definitionOf: (collection: string) => LinkingCollection | null,
  at = 'computed',
): Readonly<Record<string, CelType>> | string {
  const clash = computedClash(computed, schema, at);
  if (clash) return clash;
  const body = typeOfSchema(schema);
  const version = versionType(body);
  const fields = version.t === 'object' ? version.fields : {};
  const names = new Map<string, CelType>(Object.entries(fields));
  for (const n of ['id', 'deleted']) names.delete(n);
  names.set('creator', STRING).set('updatedAt', STRING).set('seq', INT);
  const linked = (collection: string, rel: string): CelType | string => {
    const linking = definitionOf(collection);
    if (!linking) {
      return collection.startsWith('std.')
        ? typeOfSchema(undefined)
        : `${collection} is not defined in this space: define it first`;
    }
    const declared = linking.links ?? {};
    const roles = Object.keys(declared);
    const role = Object.hasOwn(declared, rel) ? declared[rel] : undefined;
    if (!role)
      return `${collection} declares no link role "${rel}"; ${roles.length ? `it declares ${roles.map((r) => `"${r}"`).join(', ')}` : 'it declares none'}`;
    if (role.to !== '*' && !role.to.includes(name))
      return `${collection}'s "${rel}" links point at ${role.to.join(', ')}, not ${name}`;
    return typeOfSchema(linking.schema);
  };
  const types: Record<string, CelType> = {};
  for (const [field, source] of Object.entries(computed)) {
    const node = parse(source);
    if (typeof node === 'string') return `${at}.${field}: ${node}`;
    const type = typeOfCel(node, names, linked);
    if (typeof type === 'string') return `${at}.${field}: ${type}`;
    types[field] = type;
  }
  return types;
}

/** The JSON Schema of a value of this type, as far as it says */
function schemaOfType(type: CelType): Record<string, unknown> {
  switch (type.t) {
    case 'bool':
      return { type: 'boolean' };
    case 'int':
    case 'uint':
      return { type: 'integer' };
    case 'double':
      return { type: 'number' };
    case 'string':
      return { type: 'string' };
    case 'null':
      return { type: 'null' };
    case 'list':
      return { type: 'array', items: schemaOfType(type.item) };
    case 'object':
      return { type: 'object' };
    default:
      return {};
  }
}

/**
 * Each of a collection's computed fields as JSON Schema, `readOnly`, for an
 * app that shows records from their definitions: a count is an integer, a
 * comparison a boolean. A field whose type can't be worked out is `{}`. Any
 * value may also be null, where it can't be worked out for a record.
 */
export function computedSchemas(
  definition: { readonly name: string; readonly schema: unknown; readonly computed?: ComputedFields },
  definitionOf: (collection: string) => LinkingCollection | null,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const computed = definition.computed ?? {};
  const types = typesOfComputed(definition.name, computed, definition.schema, definitionOf);
  return Object.fromEntries(
    Object.keys(computed).map((field) => [
      field,
      { ...(typeof types === 'string' ? {} : schemaOfType(types[field] ?? { t: 'dyn' })), readOnly: true },
    ]),
  );
}

/**
 * A computed field named like a field of the body's schema, or null. A bare
 * name in a query reads the computed field, so the body's could never be read.
 */
function computedClash(computed: ComputedFields, schema: unknown, at = 'computed'): string | null {
  const body = typeOfSchema(schema);
  if (body.t !== 'object') return null;
  for (const field of Object.keys(computed)) {
    if (Object.hasOwn(body.fields, field))
      return `${at}.${field}: the body has a field "${field}" too; give the computed field another name`;
  }
  return null;
}

/**
 * A definition's computed fields as everything that reads them takes them:
 * none when the member is malformed, too large, or names a field like the
 * body's. `define` refuses those, but a definition written by another
 * implementation, or by hand, arrives unchecked.
 */
export function usableComputed(computed: unknown, schema: unknown): ComputedFields | undefined {
  if (computed === undefined || checkComputed(computed) !== null || !isRecord(computed)) return undefined;
  const fields = Object.fromEntries(
    Object.entries(computed).flatMap(([name, source]) =>
      typeof source === 'string' ? [[name, source]] : [],
    ),
  );
  return computedClash(fields, schema) === null ? fields : undefined;
}

/** Those of these computed fields a filter or sort names: a field whose first part is one's name */
export function namedComputed(fields: ComputedFields, where: unknown, sort?: unknown): ComputedFields {
  const named: Record<string, string> = {};
  const name = (field: string) => {
    const first = field.split('.')[0]!;
    if (Object.hasOwn(fields, first)) named[first] = fields[first]!;
  };
  const walk = (filter: unknown): void => {
    if (Array.isArray(filter)) return filter.forEach(walk);
    if (!isRecord(filter)) return;
    for (const [field, condition] of Object.entries(filter)) {
      if (field === '$and' || field === '$or' || field === '$not') walk(condition);
      else name(field);
    }
  };
  walk(where);
  if (isRecord(sort)) Object.keys(sort).forEach(name);
  return named;
}

/** Whether a filter or sort names one of these computed fields */
export const readsComputed = (fields: ComputedFields, where: unknown, sort?: unknown): boolean =>
  Object.keys(namedComputed(fields, where, sort)).length > 0;

/** What a computed field needs from the node: what links to a record */
export interface LinkedSource {
  linked(key: string, options: { rel?: string; collection?: string }): Promise<ReadonlyArray<NodeRecord>>;
}

/** A collection that computed fields read with `linked()`, and the link role they follow from it */
export interface LinkedRead {
  readonly collection: string;
  readonly rel: string;
}

/**
 * What these computed fields read with `linked()`, each once: a record of
 * one of these collections linking with that role can change their values,
 * so whatever watches a filter on them watches these too.
 */
export function linkedReads(fields: ComputedFields): ReadonlyArray<LinkedRead> {
  const reads = new Map<string, LinkedRead>();
  for (const source of Object.values(fields)) {
    const node = parse(source);
    if (typeof node === 'string') continue;
    for (const [collection, rel] of linkedCalls(node))
      reads.set(`${collection}\u0000${rel}`, { collection, rel });
  }
  return [...reads.values()];
}

/**
 * The newest record these computed fields read for the record `key`: the
 * last thing that could have changed their values, or null when they read
 * none. A record comes to match a filter on them when it is written, or
 * when this is.
 */
export async function lastRead(
  source: LinkedSource,
  key: string,
  fields: ComputedFields,
): Promise<NodeRecord | null> {
  let newest: NodeRecord | null = null;
  for (const { collection, rel } of linkedReads(fields)) {
    for (const r of await source.linked(key, { rel, collection })) {
      if (readable(r) && (!newest || r.updatedAt > newest.updatedAt)) newest = r;
    }
  }
  return newest;
}

/** Only records whose body this device could open */
export const readable = (r: NodeRecord | null): r is NodeRecord => r !== null && r.body !== null;

/** A record as `linked()` gives it: a version, as a contract reads a cited one (spec 09 §6.1) */
const asVersion = (r: NodeRecord): CelValue =>
  versionValue({
    id: r.version,
    key: r.key,
    collection: r.collection,
    seq: r.seq,
    // The account, as contracts read authors; the signing key only where no account is known.
    author: r.root ?? r.author,
    createdAt: r.updatedAt,
    deleted: false,
    body: r.body,
    links: r.links,
  });

/**
 * A record's computed values. One that gives an error for this record, or
 * runs past the limits contracts have, holds null.
 */
export async function computeValues(
  source: LinkedSource,
  record: NodeRecord,
  fields: ComputedFields,
): Promise<ComputedValues> {
  const vars = new Map<string, CelValue>([
    ['body', fromJson(record.body)],
    ['links', fromJson(record.links)],
    ['key', record.key],
    ['seq', BigInt(record.seq)],
    ['collection', record.collection],
    ['author', record.root ?? record.author],
    ['creator', record.createdBy ?? record.root ?? record.author],
    ['createdAt', record.createdAt],
    ['updatedAt', record.updatedAt],
  ]);
  // Fields often read the same links: each is looked up once per record.
  const found = new Map<string, Promise<CelValue>>();
  const linked = (collection: string, rel: string): Promise<CelValue> => {
    const at = `${collection}\u0000${rel}`;
    let list = found.get(at);
    if (!list) {
      list = source
        .linked(record.key, { rel, collection })
        .then((records) => records.filter(readable).map(asVersion));
      found.set(at, list);
    }
    return list;
  };
  const values: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(fields)) {
    const node = parse(source);
    values[name] = typeof node === 'string' ? null : await valueOf(node, vars, linked);
  }
  return Object.freeze(values);
}

async function valueOf(
  node: CelNode,
  vars: ReadonlyMap<string, CelValue>,
  linked: (collection: string, rel: string) => Promise<CelValue>,
): Promise<unknown> {
  try {
    const value = await evaluateCel(
      node,
      { vars, links: vars.get('links'), linked },
      { steps: 0, max: MAX_CEL_STEPS, work: 0, maxWork: MAX_CEL_WORK },
    );
    return isCelError(value) ? null : toJson(value);
  } catch (error) {
    // Past the limits, or a value JSON can't hold.
    if (isCelStop(error) || error instanceof TypeError) return null;
    throw error;
  }
}
