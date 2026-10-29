/**
 * Runs a query: narrow by collection, filter, sort, page, then follow links.
 *
 * Deliberately no planner: a browser holds a replica, not a warehouse. Records
 * are filtered after they are opened, so a private space is filtered on its
 * decrypted bodies, and a record this device cannot open is left out.
 */
import type { NodeRecord } from '../node/types.js';
import { checkQuery, fieldValue, matches } from './filter.js';
import { getOrAdd } from '../utils/map.js';
import {
  computeValues,
  readable,
  readsComputed,
  type ComputedFields,
  type ComputedValues,
} from './computed.js';
import {
  nameOf,
  plainQuery,
  type CollectionRef,
  type Filter,
  type Include,
  type IncludeMap,
  type Query,
  type QueryRecord,
  type QueryResult,
} from './types.js';

/** What the engine needs from a space: its current records, one by key, and what links where. */
export interface QuerySource {
  /** Current, not deleted */
  list(collection: string): Promise<ReadonlyArray<NodeRecord>>;
  get(key: string): Promise<NodeRecord | null>;
  linked(key: string, options: { rel?: string; collection?: string }): Promise<ReadonlyArray<NodeRecord>>;
  /** The collection's computed fields, from its definition; none when absent */
  computed?(collection: string): Promise<ComputedFields | undefined>;
}

/** A record with its computed values: none when its collection has none */
type Computed = NodeRecord & { readonly computed: ComputedValues };
type Compute = ReturnType<typeof computer>;

const NONE: ComputedValues = Object.freeze({});
const NO_FIELDS: ComputedFields = Object.freeze({});

/**
 * Runs a query against a space.
 * @throws When the query is malformed — with a message saying what to fix
 */
export async function runQuery<
  T = unknown,
  C extends CollectionRef = CollectionRef,
  I extends IncludeMap | undefined = IncludeMap | undefined,
>(source: QuerySource, given: Query<C, I>): Promise<QueryResult<T>> {
  const query = plainQuery(given);
  const problem = checkQuery(query);
  if (problem) throw new Error(`Invalid query: ${problem}`);

  const collection = nameOf(query.collection);
  const compute = computer(source);
  const fields = await compute.fields(collection);

  let candidates: Array<NodeRecord | Computed> = (await source.list(collection)).filter(readable);
  // Filtering or sorting on a computed field needs it for every candidate; otherwise only the page pays.
  if (readsComputed(fields, query.where, query.sort))
    candidates = await Promise.all(candidates.map(compute.withComputed));
  const filtered = query.where ? candidates.filter(matching(query.where)) : candidates;
  const sorted = sortRecords(filtered, query.sort);

  const start = startAfter(sorted, query.cursor);
  const end = query.limit === undefined ? undefined : start + query.limit;
  const page = sorted.slice(start, end);
  const records = await Promise.all(page.map((r) => expand(source, compute, r, query.include)));
  const more = page.length > 0 && start + page.length < sorted.length;
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- T is the caller's promise about bodies (see Typed); reading does not check it
    records: records as ReadonlyArray<QueryRecord<T>>,
    cursor: more ? page.at(-1)!.key : null,
    complete: true,
  };
}

/** Where a page starts: after the cursor's record, or from the top if that record has gone */
function startAfter(sorted: ReadonlyArray<NodeRecord>, cursor: string | undefined): number {
  if (!cursor) return 0;
  return sorted.findIndex((r) => r.key === cursor) + 1;
}

const matching = (where: Filter) => (record: NodeRecord) => matches(record, where);

/**
 * A total order. Ties always break on the key — stable on every node,
 * so paging neither skips nor repeats between peers holding the same data.
 */
function sortRecords<T extends NodeRecord>(records: T[], sort: Query['sort']): T[] {
  const fields = Object.entries(sort ?? { '@createdAt': 'asc' });
  return records.sort((a, b) => {
    for (const [field, direction] of fields) {
      const order = compareValues(fieldValue(a, field), fieldValue(b, field));
      if (order !== 0) return direction === 'desc' ? -order : order;
    }
    return compareText(a.key, b.key);
  });
}

/** Orders two values of a field: missing sorts first, then numbers and strings by value. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- every node must order mixed values the same way, so the stringification stays as it was
  return compareText(String(a), String(b));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Works out computed fields, each collection's definition read once per query */
function computer(source: QuerySource) {
  const fieldsOf = new Map<string, Promise<ComputedFields>>();
  const fields = (collection: string): Promise<ComputedFields> =>
    getOrAdd(fieldsOf, collection, () => readFields(source, collection));
  const withComputed = async (record: NodeRecord | Computed): Promise<Computed> => {
    if ('computed' in record) return record;
    const of = await fields(record.collection);
    const computed = Object.keys(of).length ? await computeValues(source, record, of) : NONE;
    return { ...record, computed };
  };
  return { fields, withComputed };
}

async function readFields(source: QuerySource, collection: string): Promise<ComputedFields> {
  return (await source.computed?.(collection)) ?? NO_FIELDS;
}

/** A record with its computed values and what its includes find */
async function expand(
  source: QuerySource,
  compute: Compute,
  given: NodeRecord | Computed,
  includes: Query['include'],
): Promise<QueryRecord> {
  const record = await compute.withComputed(given);
  const included: Record<string, ReadonlyArray<QueryRecord> | number> = {};
  for (const [name, include] of Object.entries(includes ?? {}))
    included[name] = await runInclude(source, compute, record, include);
  return { ...record, included };
}

/** What one include finds for a record: its records, or how many there are */
async function runInclude(
  source: QuerySource,
  compute: Compute,
  record: NodeRecord,
  include: Include,
): Promise<ReadonlyArray<QueryRecord> | number> {
  let found: ReadonlyArray<NodeRecord | Computed> = await related(source, record, include);
  if (include.where) found = await filterIncluded(compute, found, include.where);
  if (include.count) return found.length;
  const page = found.slice(0, include.limit);
  return Promise.all(page.map((r) => expand(source, compute, r, include.include)));
}

/** A record whose collection's computed fields the filter names is matched on them */
async function filterIncluded(
  compute: Compute,
  records: ReadonlyArray<NodeRecord>,
  where: Filter,
): Promise<Array<NodeRecord | Computed>> {
  const withFields = await Promise.all(
    records.map(async (r) =>
      readsComputed(await compute.fields(r.collection), where) ? compute.withComputed(r) : r,
    ),
  );
  return withFields.filter(matching(where));
}

/** The records an include finds for one record, before its `where` */
async function related(source: QuerySource, record: NodeRecord, include: Include): Promise<NodeRecord[]> {
  const from = include.from === undefined ? undefined : nameOf(include.from);
  if (include.direction !== 'out') {
    const linking = await source.linked(record.key, {
      rel: include.rel,
      ...(from ? { collection: from } : {}),
    });
    return linking.filter(readable);
  }
  const outgoing = record.links.filter((link) => link.rel === include.rel);
  const targets = await Promise.all(outgoing.map((link) => source.get(link.to)));
  // A link to a record not held here is normal; it simply finds nothing.
  return targets.filter((r): r is NodeRecord => readable(r) && (!from || r.collection === from));
}
