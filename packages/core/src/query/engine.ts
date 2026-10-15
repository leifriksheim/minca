/**
 * Runs a query: narrow by collection, filter, sort, page, then follow links.
 *
 * Deliberately no planner. A browser holds a replica, not a warehouse; at that
 * scale an optimiser would be more code than it saves. Filtering happens after
 * records are opened, so in a private space it sees decrypted bodies — and a
 * record this device cannot open is left out, here and in every `include`.
 */
import type { NodeRecord } from '../node/types.js';
import { checkQuery, fieldValue, matches } from './filter.js';
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

const NONE: ComputedValues = Object.freeze({});
const NO_FIELDS: ComputedFields = Object.freeze({});

/** Orders two values of a field: missing sorts first, then numbers and strings by value. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- every node must order mixed values the same way, so the stringification stays as it was
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

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
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** The records an include finds for one record, before its `where` */
async function related(source: QuerySource, record: NodeRecord, include: Include): Promise<NodeRecord[]> {
  const from = include.from === undefined ? undefined : nameOf(include.from);
  if (include.direction === 'out') {
    const targets = await Promise.all(
      record.links.filter((l) => l.rel === include.rel).map((l) => source.get(l.to)),
    );
    // A link to a record not held here is normal; it simply finds nothing.
    return targets.filter((r): r is NodeRecord => readable(r) && (!from || r.collection === from));
  }
  return (
    await source.linked(record.key, { rel: include.rel, ...(from ? { collection: from } : {}) })
  ).filter(readable);
}

/** Works out computed fields, each collection's definition read once per query */
function computer(source: QuerySource) {
  const fieldsOf = new Map<string, Promise<ComputedFields>>();
  const fields = (collection: string) => {
    let found = fieldsOf.get(collection);
    if (!found) {
      found = (source.computed?.(collection) ?? Promise.resolve(undefined)).then((f) => f ?? NO_FIELDS);
      fieldsOf.set(collection, found);
    }
    return found;
  };
  const withComputed = async (r: NodeRecord | Computed): Promise<Computed> => {
    if ('computed' in r) return r;
    const of = await fields(r.collection);
    return { ...r, computed: Object.keys(of).length ? await computeValues(source, r, of) : NONE };
  };
  return { fields, withComputed };
}

async function expand(
  source: QuerySource,
  compute: ReturnType<typeof computer>,
  given: NodeRecord | Computed,
  includes: Query['include'],
): Promise<QueryRecord> {
  const record = await compute.withComputed(given);
  if (!includes) return { ...record, included: {} };
  const included: Record<string, ReadonlyArray<QueryRecord> | number> = {};
  for (const [name, include] of Object.entries(includes)) {
    let found: ReadonlyArray<NodeRecord | Computed> = await related(source, record, include);
    if (include.where) {
      const where = include.where;
      // A record whose collection's computed fields the filter names is matched on them.
      found = await Promise.all(
        found.map(async (r) =>
          readsComputed(await compute.fields(r.collection), where) ? compute.withComputed(r) : r,
        ),
      );
      found = found.filter((r) => matches(r, where));
    }
    if (include.count) {
      included[name] = found.length;
      continue;
    }
    const page = include.limit === undefined ? found : found.slice(0, include.limit);
    included[name] = await Promise.all(page.map((r) => expand(source, compute, r, include.include)));
  }
  return { ...record, included };
}

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
  const filtered = query.where ? candidates.filter((r) => matches(r, query.where!)) : candidates;
  const sorted = sortRecords(filtered, query.sort);

  // The cursor is the key of the last record of the previous page. If that
  // record has since gone, start from where it would have been.
  let start = 0;
  if (query.cursor) {
    const at = sorted.findIndex((r) => r.key === query.cursor);
    start = at >= 0 ? at + 1 : 0;
  }
  const page = query.limit === undefined ? sorted.slice(start) : sorted.slice(start, start + query.limit);
  const records = await Promise.all(page.map((r) => expand(source, compute, r, query.include)));
  const more = start + page.length < sorted.length && page.length > 0;
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- T is the caller's promise about bodies (see Typed); reading does not check it
    records: records as ReadonlyArray<QueryRecord<T>>,
    cursor: more ? page[page.length - 1]!.key : null,
    complete: true,
  };
}
