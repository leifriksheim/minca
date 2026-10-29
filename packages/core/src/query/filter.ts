/** The filter operators, as pure functions over opened records. */
import type { NodeRecord } from '../node/types.js';
import type { Filter } from './types.js';
import { isRecord, isObject } from '../utils/guards.js';
import { LINK_FIELD_PATTERN } from '../records/links.js';

/** Nested `include` beyond this is refused rather than quietly slow. */
export const MAX_INCLUDE_DEPTH = 3;

/** Filters nest at most this deep: a subscription's or rule's, judged on records as they arrive */
const MAX_FILTER_DEPTH = 16;

/**
 * What a filter reads of a record: a query's results have all of it; a
 * subscription matching a record an app just saw has its outside and body;
 * a rule's results also have what the query's `include` found.
 */
export type FilterSubject = Pick<
  NodeRecord,
  'key' | 'collection' | 'body' | 'links' | 'createdBy' | 'createdAt'
> &
  Partial<Pick<NodeRecord, 'author' | 'root' | 'updatedAt' | 'seq'>> & {
    readonly included?: Readonly<Record<string, unknown>>;
    /** Its collection's computed fields (packages/core/docs/computed.md), read in place of the body's */
    readonly computed?: Readonly<Record<string, unknown>>;
  };

const META: Record<string, (r: FilterSubject) => unknown> = {
  '@key': (r) => r.key,
  '@author': (r) => r.author,
  '@root': (r) => r.root,
  '@createdBy': (r) => r.createdBy,
  '@createdAt': (r) => r.createdAt,
  '@updatedAt': (r) => r.updatedAt,
  '@seq': (r) => r.seq,
  '@collection': (r) => r.collection,
};
const META_FIELDS = Object.keys(META);

/** Ordered comparison, only between two numbers or two strings. */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

const ordered = (holds: (order: number) => boolean) => (value: unknown, operand: unknown) => {
  const order = compare(value, operand);
  return order !== null && holds(order);
};

/** Whether a value, or any item of a list, equals one of these */
function anyIn(value: unknown, operand: unknown): boolean {
  if (!Array.isArray(operand)) return false;
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => operand.some((o) => equal(item, o))) || operand.some((o) => equal(value, o));
}

function contains(value: unknown, operand: unknown): boolean {
  if (typeof value === 'string' && typeof operand === 'string')
    return value.toLowerCase().includes(operand.toLowerCase());
  return Array.isArray(value) && value.some((item) => equal(item, operand));
}

const OPERATORS: Readonly<Record<string, (value: unknown, operand: unknown) => boolean>> = {
  $eq: (value, operand) => equal(value, operand),
  $ne: (value, operand) => !equal(value, operand),
  $gt: ordered((order) => order > 0),
  $gte: ordered((order) => order >= 0),
  $lt: ordered((order) => order < 0),
  $lte: ordered((order) => order <= 0),
  // A list field is in the operand when any of its items is: "tagged with any of these".
  $in: anyIn,
  $nin: (value, operand) => Array.isArray(operand) && !anyIn(value, operand),
  $exists: (value, operand) => (value !== undefined) === operand,
  $contains: contains,
};
const OPERATOR_NAMES = Object.keys(OPERATORS);

/**
 * A field of a record: `@…` for the record itself, `link:<rel>` for where its
 * first link of that role points (missing when it has none), a dotted path
 * otherwise: into a computed field when the first part names one, else into
 * its body. A body can't stand in for a computed field by holding its name.
 */
export function fieldValue(record: FilterSubject, path: string): unknown {
  if (path.startsWith('include:')) return ownMember(record.included, path.slice('include:'.length));
  if (path.startsWith('link:')) {
    if (!LINK_FIELD_PATTERN.test(path)) throw new Error(`"${path}" is not a link role, like "link:channel"`);
    const rel = path.slice('link:'.length);
    return record.links.find((link) => link.rel === rel)?.to;
  }
  if (path.startsWith('@')) {
    const read = META[path];
    if (!read) throw new Error(`Unknown record field "${path}" — use one of ${META_FIELDS.join(', ')}`);
    return read(record);
  }
  const [first = '', ...rest] = path.split('.');
  if (record.computed && Object.hasOwn(record.computed, first)) return readPath(record.computed[first], rest);
  return readPath(record.body, [first, ...rest]);
}

/** Own members only, nothing a runtime adds to every object; and of a list, only its positions */
function readPath(start: unknown, parts: ReadonlyArray<string>): unknown {
  let value = start;
  for (const part of parts) {
    if (Array.isArray(value)) {
      const items: ReadonlyArray<unknown> = value;
      value = /^(0|[1-9][0-9]*)$/.test(part) ? items[Number(part)] : undefined;
      continue;
    }
    if (!isObject(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

const ownMember = (object: Readonly<Record<string, unknown>> | undefined, name: string): unknown =>
  object && Object.hasOwn(object, name) ? object[name] : undefined;

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => equal(a[k], b[k]));
}

function operatorHolds(op: string, value: unknown, operand: unknown): boolean {
  if (!Object.hasOwn(OPERATORS, op)) throw new Error(`Unknown operator ${op}`);
  return OPERATORS[op]!(value, operand);
}

/** An object whose keys are all operators, like `{ $gt: 3 }` */
const isOperatorObject = (condition: unknown): condition is Record<string, unknown> =>
  isRecord(condition) &&
  Object.keys(condition).length > 0 &&
  Object.keys(condition).every((k) => k.startsWith('$'));

/** Whether one field satisfies a condition: an operator object, or a value to equal. */
function conditionHolds(value: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return equal(value, condition);
  return Object.entries(condition).every(([op, operand]) => operatorHolds(op, value, operand));
}

/** Whether a record matches a filter. */
export function matches(record: FilterSubject, filter: Filter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$and') return (filter.$and ?? []).every((f) => matches(record, f));
    if (field === '$or') return (filter.$or ?? []).some((f) => matches(record, f));
    if (field === '$not') return !matches(record, filter.$not ?? {});
    return conditionHolds(fieldValue(record, field), condition);
  });
}

// ─── Checking a query before running it ─────────────────────────────

interface FilterOptions {
  readonly include?: boolean;
  /** The `@` fields it may read, when not all of them: a subscription sees only a record's outside */
  readonly meta?: ReadonlyArray<string>;
}

/**
 * Why a filter can't be used, or null. `include` lets it read `include:<name>`,
 * what a rule's query included.
 */
export function checkFilter(
  filter: unknown,
  at = 'where',
  options: FilterOptions = {},
  depth = 1,
): string | null {
  if (!isRecord(filter)) return `${at} must be an object`;
  if (depth > MAX_FILTER_DEPTH) return `${at}: filters nest at most ${MAX_FILTER_DEPTH} deep`;
  for (const [field, condition] of Object.entries(filter)) {
    const problem =
      field === '$and' || field === '$or' || field === '$not'
        ? checkLogical(field, condition, at, options, depth)
        : checkField(field, condition, at, options);
    if (problem) return problem;
  }
  return null;
}

function checkLogical(
  field: '$and' | '$or' | '$not',
  condition: unknown,
  at: string,
  options: FilterOptions,
  depth: number,
): string | null {
  if (field === '$not') return checkFilter(condition, `${at}.$not`, options, depth + 1);
  if (!Array.isArray(condition)) return `${at}.${field} must be a list of filters`;
  for (const [i, sub] of condition.entries()) {
    const problem = checkFilter(sub, `${at}.${field}[${i}]`, options, depth + 1);
    if (problem) return problem;
  }
  return null;
}

function checkField(field: string, condition: unknown, at: string, options: FilterOptions): string | null {
  const meta = options.meta ?? META_FIELDS;
  if (field.startsWith('$'))
    return `${at}: "${field}" is not a field or a logical operator ($and, $or, $not)`;
  if (field.startsWith('@') && !meta.includes(field))
    return `${at}: unknown record field "${field}" — use one of ${meta.join(', ')}`;
  if (
    field.startsWith('include:') &&
    !(options.include && /^include:[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field))
  )
    return `${at}: "${field}" reads what a rule's query included, like "include:messages"`;
  if (field.startsWith('link:') && !LINK_FIELD_PATTERN.test(field))
    return `${at}: "${field}" is not a link role, like "link:channel"`;
  if (!isRecord(condition) || !Object.keys(condition).some((k) => k.startsWith('$'))) return null;
  const unknown = Object.keys(condition).find((op) => !OPERATOR_NAMES.includes(op));
  return unknown === undefined
    ? null
    : `${at}.${field}: unknown operator "${unknown}" — use one of ${OPERATOR_NAMES.join(', ')}`;
}

const isWholeNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function checkIncludes(includes: unknown, at: string, depth: number): string | null {
  if (!isRecord(includes)) return `${at} must be an object of named includes`;
  if (depth > MAX_INCLUDE_DEPTH) return `${at}: includes nest at most ${MAX_INCLUDE_DEPTH} deep`;
  for (const [name, include] of Object.entries(includes)) {
    const problem = checkInclude(include, `${at}.${name}`, depth);
    if (problem) return problem;
  }
  return null;
}

function checkInclude(inc: unknown, here: string, depth: number): string | null {
  if (!isRecord(inc)) return `${here} must be an object`;
  if (typeof inc.rel !== 'string') return `${here}.rel is required: the link role to follow, e.g. "about"`;
  if (inc.from !== undefined && typeof inc.from !== 'string') return `${here}.from must be a collection name`;
  if (inc.direction !== undefined && inc.direction !== 'in' && inc.direction !== 'out')
    return `${here}.direction must be "in" or "out"`;
  if (inc.limit !== undefined && !isWholeNumber(inc.limit)) return `${here}.limit must be a whole number`;
  if (inc.where !== undefined) {
    const problem = checkFilter(inc.where, `${here}.where`);
    if (problem) return problem;
  }
  if (inc.include !== undefined) return checkIncludes(inc.include, `${here}.include`, depth + 1);
  return null;
}

function checkSort(sort: unknown): string | null {
  if (!isRecord(sort)) return 'sort must be an object: { field: "asc" | "desc" }';
  for (const [field, direction] of Object.entries(sort)) {
    if (direction !== 'asc' && direction !== 'desc') return `sort.${field} must be "asc" or "desc"`;
    if (field.startsWith('@') && !META[field]) return `sort: unknown record field "${field}"`;
    if (field.startsWith('link:') && !LINK_FIELD_PATTERN.test(field))
      return `sort: "${field}" is not a link role`;
  }
  return null;
}

/** Why a query cannot run, or null when it can. Queries are data; functions and unknown operators are refused. */
export function checkQuery(query: unknown): string | null {
  if (!isRecord(query)) return 'A query must be an object';
  if (typeof query.collection !== 'string' || !query.collection) return 'A query needs a "collection"';
  const problem =
    (query.where !== undefined ? checkFilter(query.where, 'where') : null) ??
    (query.include !== undefined ? checkIncludes(query.include, 'include', 1) : null) ??
    (query.sort !== undefined ? checkSort(query.sort) : null);
  if (problem) return problem;
  if (query.limit !== undefined && !isWholeNumber(query.limit)) return 'limit must be a whole number';
  if (query.cursor !== undefined && typeof query.cursor !== 'string')
    return 'cursor must be the string a previous page returned';
  return null;
}
