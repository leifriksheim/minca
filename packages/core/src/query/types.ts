/**
 * A query is plain data: an object you could write by hand, send over a wire,
 * or have an agent produce. No parser, no language — filters borrow Mongo's
 * operators, relationships borrow the `include` map that Prisma, Mongoose and
 * Rails all use, and anything that serialises keeps working the day a daemon
 * answers queries instead of the tab.
 */
import type { NodeRecord } from '../node/types.js';
import { isRecord, isObject } from '../utils/guards.js';
import type { ComputedValues } from './computed.js';
import type { ComputedOf } from '../records/contract-builder.js';

/** Predicates on one field. Absent operators do not constrain. */
export interface Operators {
  readonly $eq?: unknown;
  /** True for a missing field too — the one everybody gets wrong */
  readonly $ne?: unknown;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: ReadonlyArray<unknown>;
  readonly $nin?: ReadonlyArray<unknown>;
  readonly $exists?: boolean;
  /** Case-insensitive substring of a text field, or an element of a list. Not search. */
  readonly $contains?: unknown;
}

/**
 * Field predicates, all of which must hold.
 *
 * A bare name is a field of the record's body — `done`, `address.city`. A
 * name starting with `@` is about the record itself: `@key`, `@author`,
 * `@root`, `@createdBy`, `@createdAt`, `@updatedAt`, `@seq`. `link:<rel>` is
 * the key its first link of that role points at: `{ 'link:channel': key }`.
 */
export type Filter = {
  readonly [field: string]: unknown;
} & {
  readonly $and?: ReadonlyArray<Filter>;
  readonly $or?: ReadonlyArray<Filter>;
  readonly $not?: Filter;
};

/**
 * A collection, by name or by a reference that also carries its records'
 * type: a definition whose schema is a validator (a Zod object), a standard
 * one from `@minca/core/schemas`, or a {@link Typed} name. Before a query
 * runs, every reference becomes its name — the query stays plain data.
 */
export type CollectionRef = string | { readonly name: string };

/**
 * A collection name that carries its records' type, for collections whose
 * schema is plain JSON Schema: `const todos: Typed<Todo> = { name: 'app.todo' }`.
 * The type is a promise you make, not something checked when reading.
 */
export interface Typed<T> {
  readonly name: string;
  readonly '~body'?: T;
}

/** A validator's output type, when it declares one (Standard Schema) */
type OutputOf<S> = S extends { readonly '~standard': { readonly types?: infer Types } }
  ? NonNullable<Types> extends { readonly output: infer O }
    ? O
    : unknown
  : unknown;

/**
 * The body type of a collection reference: declared with {@link Typed}, or
 * the output of its definition's validator. `unknown` for a bare name.
 */
export type BodyOf<C> = C extends { readonly '~body'?: infer T }
  ? unknown extends T
    ? FromSchema<C>
    : T
  : FromSchema<C>;
type FromSchema<C> = C extends { readonly schema: infer S } ? OutputOf<S> : unknown;

/**
 * What an `include` map finds for each record, typed from the query. A map
 * only known as "some includes" (a query built at run time) gives the loose
 * {@link AnyIncluded}.
 */
export type IncludedOf<I> = [I] extends [undefined]
  ? Record<never, never>
  : string extends keyof NonNullable<I>
    ? AnyIncluded
    : {
        readonly [K in keyof NonNullable<I>]: NonNullable<I>[K] extends { readonly count: true }
          ? number
          : ReadonlyArray<
              QueryRecord<
                BodyOf<NonNullable<I>[K] extends { readonly from?: infer F } ? F : never>,
                IncludedOf<NonNullable<I>[K] extends { readonly include?: infer J } ? J : undefined>,
                ComputedIn<NonNullable<I>[K] extends { readonly from?: infer F } ? F : never>
              >
            >;
      };

/**
 * The computed fields of a collection reference, typed from its definition's
 * builder: `computed: ({ linked }) => ({ done: … })` gives `{ done: boolean | null }`.
 */
export type ComputedIn<C> = C extends { readonly computed?: infer F }
  ? [Extract<F, (scope: never) => unknown>] extends [never]
    ? ComputedValues
    : Extract<F, (scope: never) => unknown> extends (scope: never) => infer M
      ? ComputedOf<M>
      : ComputedValues
  : ComputedValues;

/** What to pull in alongside each record, by following links. */
export interface Include {
  /** The link role: 'about', 'replyTo' */
  readonly rel: string;
  /** Only records in this collection — by name, or a reference that carries its type */
  readonly from?: CollectionRef;
  /** `in` (default): records linking *to* this one. `out`: records this one links to. */
  readonly direction?: 'in' | 'out';
  readonly where?: Filter;
  readonly include?: Readonly<Record<string, Include>>;
  readonly limit?: number;
  /** Just the number of them — the usual thing for reactions and votes */
  readonly count?: boolean;
}

export type SortDirection = 'asc' | 'desc';

/** Named includes */
export type IncludeMap = Readonly<Record<string, Include>>;

/**
 * A query. With a typed collection (a definition made with `collection()`,
 * or a {@link Typed} name), `where` and `sort` are typed from it: its body's
 * fields, its link roles and its computed fields, each with its value's type.
 */
export interface Query<
  C extends CollectionRef = CollectionRef,
  I extends IncludeMap | undefined = IncludeMap | undefined,
> {
  /** By name, or a reference that carries its records' type (see {@link CollectionRef}) */
  readonly collection: C;
  readonly where?: FilterOf<C>;
  readonly include?: I;
  /** Fields to sort by, in order: `{ done: 'asc', '@createdAt': 'desc' }`. Ties always break on the key. */
  readonly sort?: SortOf<C>;
  readonly limit?: number;
  /** From the previous page's `cursor` */
  readonly cursor?: string;
}

/** What an untyped query's `include` finds */
export type AnyIncluded = Readonly<Record<string, ReadonlyArray<QueryRecord> | number>>;

/**
 * A record a query found. Queries only return records this device can read,
 * so `body` is never null here.
 */
export interface QueryRecord<T = unknown, I = AnyIncluded, C = ComputedValues> extends Omit<
  NodeRecord<T>,
  'body'
> {
  readonly body: T;
  /** What each `include` found: records, or a number when it asked for a count. Empty without `include`. */
  readonly included: I;
  /**
   * Its collection's computed fields, derived from what this node holds
   * (packages/core/docs/computed.md). Empty when the collection has none.
   */
  readonly computed: C;
}

export interface QueryResult<T = unknown, I = AnyIncluded, C = ComputedValues> {
  readonly records: ReadonlyArray<QueryRecord<T, I, C>>;
  /** Pass back as `cursor` for the next page; null when there is none */
  readonly cursor: string | null;
  /**
   * Whether this node has everything the query could find. False only on a
   * node holding part of a space, while a collection the query needs is still
   * on its way — show "Loading…", not "Nothing here". A `watch` calls back
   * again when it turns true.
   */
  readonly complete: boolean;
}

/** The result a query of collection `C` with includes `I` gives */
export type ResultFor<C, I> = QueryResult<
  BodyOf<C>,
  [I] extends [undefined] ? Record<never, never> : IncludedOf<I>,
  ComputedIn<C>
>;

/** The result a query gives, typed from the query itself */
export type ResultOf<Q extends Query> = ResultFor<
  Q['collection'],
  Q extends { readonly include: infer I } ? I : 'include' extends keyof Q ? IncludeMap : undefined
>;

// -- Typed filters ------------------------------------------------------------

type Meta =
  '@key' | '@author' | '@root' | '@createdBy' | '@createdAt' | '@updatedAt' | '@seq' | '@collection';

/** How deep body paths go: `a`, `a.b`, `a.b.c` */
type Deeper = [never, 0, 1];
type PathsOf<T, D extends number = 2> = [D] extends [never]
  ? never
  : T extends ReadonlyArray<unknown>
    ? never
    : T extends object
      ? {
          [K in keyof T & string]:
            | K
            | (NonNullable<T[K]> extends ReadonlyArray<unknown>
                ? never
                : NonNullable<T[K]> extends object
                  ? `${K}.${PathsOf<NonNullable<T[K]>, Deeper[D]>}`
                  : never);
        }[keyof T & string]
      : never;
type AtPath<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? AtPath<NonNullable<T[H]>, R>
    : unknown
  : P extends keyof T
    ? T[P]
    : unknown;

type BuilderOf<F> = Extract<F, (scope: never) => unknown>;
/** The names of a collection's computed fields: those its builder gives, or its stored CEL's keys; none without */
type ComputedNames<C> = C extends { readonly computed?: infer F }
  ? [BuilderOf<F>] extends [never]
    ? keyof NonNullable<F> & string
    : BuilderOf<F> extends (scope: never) => infer M
      ? keyof M & string
      : never
  : never;
type LinkRoles<C> = C extends { readonly links?: infer L } ? keyof NonNullable<L> & string : never;

/** Every field a filter on `C` may name: a computed field by its bare name, as a body field */
type FieldOf<C> = Meta | `link:${LinkRoles<C>}` | ComputedNames<C> | PathsOf<BodyOf<C>>;

type ValueOfField<C, F extends string> =
  F extends ComputedNames<C>
    ? F extends keyof ComputedIn<C>
      ? ComputedIn<C>[F]
      : unknown
    : F extends '@seq'
      ? number
      : F extends Meta | `link:${string}`
        ? string | null
        : AtPath<BodyOf<C>, F>;

type ItemOf<V> = V extends ReadonlyArray<infer E> ? E : V;

/** Operators on a field whose value is a `V` */
export interface OperatorsFor<V> {
  readonly $eq?: V | null;
  readonly $ne?: V | null;
  readonly $gt?: Extract<NonNullable<V>, number | string>;
  readonly $gte?: Extract<NonNullable<V>, number | string>;
  readonly $lt?: Extract<NonNullable<V>, number | string>;
  readonly $lte?: Extract<NonNullable<V>, number | string>;
  readonly $in?: ReadonlyArray<ItemOf<NonNullable<V>>>;
  readonly $nin?: ReadonlyArray<ItemOf<NonNullable<V>>>;
  readonly $exists?: boolean;
  readonly $contains?: NonNullable<V> extends ReadonlyArray<infer E>
    ? E
    : NonNullable<V> extends string
      ? string
      : never;
}

type ConditionFor<V> = unknown extends V ? unknown : V | null | OperatorsFor<V>;

/** A filter on a collection whose records' type is known: every field it names, typed */
export type TypedFilter<C> = {
  readonly [F in FieldOf<C>]?: ConditionFor<ValueOfField<C, F>>;
} & {
  readonly $and?: ReadonlyArray<TypedFilter<C>>;
  readonly $or?: ReadonlyArray<TypedFilter<C>>;
  readonly $not?: TypedFilter<C>;
};

/** A filter on `C`: typed when its records' type is known, any {@link Filter} otherwise */
export type FilterOf<C> = unknown extends BodyOf<C> ? Filter : TypedFilter<C>;

/** A sort on `C`: its fields, typed as a filter's are */
export type SortOf<C> =
  unknown extends BodyOf<C>
    ? Readonly<Record<string, SortDirection | undefined>>
    : { readonly [F in FieldOf<C>]?: SortDirection };

/** The name a collection reference stands for */
export const nameOf = (ref: CollectionRef): string =>
  isObject(ref) && typeof ref.name === 'string'
    ? ref.name
    : // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a malformed reference passes through, for the checker to explain
      (ref as string);

/** Every `from` in an include map replaced by its name, at every depth */
function plainIncludes(map: Readonly<Record<string, Include>>): Readonly<Record<string, Include>> {
  if (!isRecord(map)) return map;
  return Object.fromEntries(
    Object.entries(map).map(([name, inc]) => [
      name,
      isRecord(inc)
        ? {
            ...inc,
            ...(inc.from !== undefined ? { from: nameOf(inc.from) } : {}),
            ...(inc.include !== undefined ? { include: plainIncludes(inc.include) } : {}),
          }
        : inc,
    ]),
  );
}

/**
 * The query as plain data: every collection reference replaced by its name.
 * What runs, what is sent to an agent, and what is compared, is this.
 * Anything malformed is passed through untouched, for the checker to explain.
 */
export function plainQuery<C extends CollectionRef, I extends IncludeMap | undefined>(
  typed: Query<C, I>,
): Query {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a typed query is a query: its types only narrow what a caller may write
  const query = typed as unknown as Query;
  if (!isRecord(query)) return query;
  return {
    ...query,
    collection: nameOf(query.collection),
    ...(query.include !== undefined ? { include: plainIncludes(query.include) } : {}),
  };
}
