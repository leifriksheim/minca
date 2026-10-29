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
import { getOrAdd } from '../utils/map.js';

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

/** A `linked(collection, rel)` call's key in a map */
const linkedKey = (collection: string | undefined, rel: string | undefined) => `${collection}\u0000${rel}`;

const parsed = new Map<string, CelNode>();
/** An expression's parse, cached; or why it doesn't parse */
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
    const problem = checkField(name, source, count);
    if (problem) return `${at}.${name}${problem}`;
    if (count.nodes > MAX_NODES) return `${at}: computed fields are too large (at most ${MAX_NODES} parts)`;
  }
  return null;
}

/** Why one computed field can't be used, said after its name; `count` adds up the parts of all of them */
function checkField(name: string, source: unknown, count: { nodes: number }): string | null {
  if (!NAME.test(name)) return ': a name is lower camel case, like "done" or "thumbsUp"';
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_LENGTH)
    return ` is a CEL expression, at most ${MAX_LENGTH} characters`;
  const node = parse(source);
  if (typeof node === 'string') return `: ${node}`;
  const problem = checkCel(node, { names: NAMES, linked: true, linkRel: LINK_REL_PATTERN }, count);
  if (problem) return `: ${problem}`;
  const bad = linkedCalls(node).find(([collection]) => !COLLECTION.test(collection));
  if (bad) return `: linked() takes a collection name, like "app.reaction"; "${bad[0]}" is not one`;
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
  const names = namesOf(schema);
  const linked = linkedType(name, definitionOf);
  const types: Record<string, CelType> = {};
  for (const [field, source] of Object.entries(computed)) {
    const node = parse(source);
    const type = typeof node === 'string' ? node : typeOfCel(node, names, linked);
    if (typeof type === 'string') return `${at}.${field}: ${type}`;
    types[field] = type;
  }
  return types;
}

/** The types of what a computed field reads of its record */
function namesOf(schema: unknown): Map<string, CelType> {
  const version = versionType(typeOfSchema(schema));
  const names = new Map<string, CelType>(Object.entries(version.t === 'object' ? version.fields : {}));
  names.delete('id');
  names.delete('deleted');
  return names.set('creator', STRING).set('updatedAt', STRING).set('seq', INT);
}

/** The type of a `linked(collection, rel)` from collection `name`, or why it can't be called */
function linkedType(name: string, definitionOf: (collection: string) => LinkingCollection | null) {
  return (collection: string, rel: string): CelType | string => {
    const linking = definitionOf(collection);
    if (!linking) {
      return collection.startsWith('std.')
        ? typeOfSchema(undefined)
        : `${collection} is not defined in this space: define it first`;
    }
    const declared = linking.links ?? {};
    const role = Object.hasOwn(declared, rel) ? declared[rel] : undefined;
    if (!role) return `${collection} declares no link role "${rel}"; ${declaredRoles(declared)}`;
    if (role.to !== '*' && !role.to.includes(name))
      return `${collection}'s "${rel}" links point at ${role.to.join(', ')}, not ${name}`;
    return typeOfSchema(linking.schema);
  };
}

function declaredRoles(declared: Readonly<Record<string, unknown>>): string {
  const roles = Object.keys(declared);
  return roles.length ? `it declares ${roles.map((r) => `"${r}"`).join(', ')}` : 'it declares none';
}

const JSON_TYPES: Readonly<Partial<Record<CelType['t'], string>>> = {
  bool: 'boolean',
  int: 'integer',
  uint: 'integer',
  double: 'number',
  string: 'string',
  null: 'null',
  object: 'object',
};

/** The JSON Schema of a value of this type, as far as it says */
function schemaOfType(type: CelType): Record<string, unknown> {
  if (type.t === 'list') return { type: 'array', items: schemaOfType(type.item) };
  const name = JSON_TYPES[type.t];
  return name ? { type: name } : {};
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
  const schemaOf = (field: string) =>
    typeof types === 'string' ? {} : schemaOfType(types[field] ?? { t: 'dyn' });
  return Object.fromEntries(
    Object.keys(computed).map((field) => [field, { ...schemaOf(field), readOnly: true }]),
  );
}

/**
 * A computed field named like a field of the body's schema, or null. A bare
 * name in a query reads the computed field, so the body's could never be read.
 */
function computedClash(computed: ComputedFields, schema: unknown, at = 'computed'): string | null {
  const body = typeOfSchema(schema);
  if (body.t !== 'object') return null;
  const field = Object.keys(computed).find((name) => Object.hasOwn(body.fields, name));
  if (field === undefined) return null;
  return `${at}.${field}: the body has a field "${field}" too; give the computed field another name`;
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
      reads.set(linkedKey(collection, rel), { collection, rel });
  }
  return [...reads.values()];
}

/** At most this many of the newest records a cause is looked for among: each costs working the fields out again */
const MAX_CAUSES = 64;

/**
 * What made a filter on these computed fields hold for a record: of the
 * records they read, the newest whose taking away, with every newer one,
 * stops it holding. A 😡 after the second 👍 changes nothing, so the 👍 is
 * the cause, and who wrote it and when is what an automation judges. The
 * record itself when it holds with none of them; null when it doesn't hold,
 * or when it would still hold without the 64 newest, so what made it hold
 * can't be told. Newest goes by the writers' clocks, which no peer checks.
 */
export async function causeOf(
  source: LinkedSource,
  record: NodeRecord,
  fields: ComputedFields,
  holds: (computed: ComputedValues) => boolean,
): Promise<NodeRecord | null> {
  // Each collection and role looked up once; taking records away filters what was found.
  const found = new Map<string, ReadonlyArray<NodeRecord>>();
  for (const { collection, rel } of linkedReads(fields)) {
    const linking = await source.linked(record.key, { rel, collection });
    found.set(linkedKey(collection, rel), linking.filter(readable));
  }
  const gone = new Set<string>();
  const without: LinkedSource = {
    linked: async (_key, { rel, collection }) =>
      (found.get(linkedKey(collection, rel)) ?? []).filter((r) => !gone.has(r.key)),
  };
  if (!holds(await computeValues(without, record, fields))) return null;
  const byKey = new Map([...found.values()].flat().map((r) => [r.key, r]));
  const newestFirst = [...byKey.values()].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.key.localeCompare(a.key),
  );
  for (const r of newestFirst.slice(0, MAX_CAUSES)) {
    gone.add(r.key);
    if (!holds(await computeValues(without, record, fields))) return r;
  }
  return newestFirst.length <= MAX_CAUSES ? record : null;
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
  const linked = (collection: string, rel: string): Promise<CelValue> =>
    getOrAdd(found, linkedKey(collection, rel), async () => {
      const linking = await source.linked(record.key, { rel, collection });
      return linking.filter(readable).map(asVersion);
    });
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
