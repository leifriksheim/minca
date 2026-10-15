/**
 * Collections a space describes itself, as data.
 *
 * `StandardSchemaV1` is a runtime object carrying a function — it cannot be
 * written into a space and read by another app. So a space stores **JSON
 * Schema**, and Standard Schema becomes the adapter that runs it locally.
 * A validator that can describe itself as JSON Schema (Standard JSON Schema:
 * Zod 4.2+, ArkType, Valibot) can be handed to a definition directly —
 * {@link toJsonSchema} turns it into what gets stored.
 *
 * Only a small, fixed subset may be *published*, so every app in any language
 * agrees on what a stored schema means:
 *
 *   type · properties · required · items · enum · minimum · maximum ·
 *   minLength · maxLength · minItems · maxItems · additionalProperties
 *   (boolean) · title · description
 *
 * plus two ways to say what a value *means*, so any app can show it well:
 *
 * - `oneOf: [{ const, title }]` — fixed choices with labels, the standard
 *   JSON Schema way (`enum` has no labels).
 * - `x-choicesFrom: { rel, field }` — the value picks from a list in another
 *   record: the one this record links to as `rel`, in its field `field`. A
 *   vote's `choice` picks from the `options` of the poll it is `about`. A
 *   number is a position in that list; anything else is the option itself.
 *   Not checked when validating — the other record may not be here yet.
 *
 * Anything else is refused at publish time — loudly, where the author can fix
 * it. At validation time unknown keywords are ignored instead, so a space
 * written by a newer app that allows more stays readable by an older one.
 */
import { Validator, type Schema } from '@cfworker/json-schema';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '../types.js';
import { LINK_REL_PATTERN, type LinkDeclaration } from '../records/links.js';
import type { DefineCollection } from '../node/types.js';
import { checkRules, type CollectionRules } from '../records/rules.js';
import type { CollectionContract, Contract, Line } from '../records/contracts.js';
import type { ComputedFields } from '../query/computed.js';
import type {
  BoolLike,
  ComputedContext,
  ComputedResult,
  ContractContext,
} from '../records/contract-builder.js';
import type { BodyOf } from '../query/types.js';
import { checkTopics } from '../records/topics.js';
import { isObject, isRecord } from '../utils/guards.js';

export type JsonSchema = { readonly [keyword: string]: unknown };

type BodyOfSchema<S> = BodyOf<{ readonly schema: S }>;

/**
 * A collection definition as `collection()` takes it: its computed fields and
 * contract built in TypeScript, typed from its own schema and name.
 */
export interface CollectionDefinition<
  N extends string = string,
  S = JsonSchema | StandardJSONSchemaV1,
  L = Readonly<Record<string, LinkDeclaration>>,
  M extends ComputedResult = ComputedResult,
> extends Omit<DefineCollection, 'name' | 'schema' | 'links' | 'computed' | 'contract'> {
  readonly name: N;
  readonly schema: S;
  readonly links?: L;
  /**
   * Values every app derives the same way from what links to its records:
   * `({ linked }) => ({ thumbs: linked(reaction, 'on').count() })`. A view of
   * what a node holds, not a verdict (packages/core/docs/computed.md).
   */
  readonly computed?: ComputedFields | ((scope: ComputedContext<BodyOfSchema<S>, N>) => M);
  /**
   * What a version must be to count, judged by every reader:
   * `check: ({ body }) => ({ 'Why it is refused': body.amount.gte(0) })`, and
   * whether the collection is a `line` (packages/core/docs/contracts.md).
   */
  readonly contract?: {
    readonly check?:
      | ReadonlyArray<Contract>
      | ((scope: ContractContext<BodyOfSchema<S>>) => Readonly<Record<string, BoolLike>>);
    readonly line?: Line;
  };
}

/** Computed fields named like a body field: a query reads a computed field by its bare name */
type Clash<S, M> = string extends keyof NonNullable<BodyOfSchema<S>>
  ? never
  : Extract<keyof M, keyof NonNullable<BodyOfSchema<S>>> & string;
type NoClash<S, M> = [Clash<S, M>] extends [never]
  ? unknown
  : { readonly computed: `"${Clash<S, M>}" is a body field too: give the computed field another name` };

/**
 * A collection definition, kept as written: its validator's type comes along,
 * so querying or writing with it is typed, and its computed fields and
 * contract are typed from its schema, its name and the collections they read.
 *
 * ```ts
 * const todo = collection({
 *   name: 'app.todo',
 *   schema: z.object({ text: z.string() }),
 *   computed: ({ linked }) => {
 *     const thumbs = linked(reaction, 'on').where((r) => r.body.emoji.eq('👍')).count();
 *     return { thumbs, done: thumbs.gte(2) };
 *   },
 * });
 * await node.collections.define(space.id, todo);
 * const { records } = await node.records.query(space.id, { collection: todo });
 * records[0]?.computed.done; // boolean | null
 * ```
 */
export function collection<
  const N extends string,
  const S extends JsonSchema | StandardJSONSchemaV1,
  const L extends Readonly<Record<string, LinkDeclaration>> = Record<never, never>,
  const M extends ComputedResult = Record<never, never>,
>(definition: CollectionDefinition<N, S, L, M> & NoClash<S, M>): CollectionDefinition<N, S, L, M> {
  return definition;
}

/**
 * The JSON Schema to store for a definition's schema: plain JSON Schema as
 * it is, or what a Standard JSON Schema validator (a Zod object, say) says it
 * accepts. The result is checked like any other — a validator feature that
 * has no stored equivalent, like a regex, is refused with the reason.
 */
export function toJsonSchema(schema: JsonSchema | StandardJSONSchemaV1): JsonSchema {
  if (!isStandardJsonSchema(schema)) return schema;
  const standard = schema['~standard'];
  if (typeof standard.jsonSchema?.input !== 'function') {
    throw new Error(
      `This ${standard.vendor ?? ''} schema can't describe itself as JSON Schema, which is what a space stores. ` +
        'Use Zod 4.2+, ArkType 2.1.28+, Valibot with toStandardJsonSchema, or plain JSON Schema.',
    );
  }
  // What was accepted is what gets stored; the dialect marker adds nothing.
  const { $schema: _dialect, ...json } = standard.jsonSchema.input({ target: 'draft-2020-12' });
  return json;
}

function isStandardJsonSchema(schema: JsonSchema | StandardJSONSchemaV1): schema is StandardJSONSchemaV1 {
  return '~standard' in schema && Boolean(schema['~standard']);
}

/** A collection, as a space describes it to whoever opens it. */
export interface StoredCollection {
  /** Reverse-DNS, like `app.todo.item`. `sys.*` is the protocol's own. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON Schema for a record's body */
  readonly schema: JsonSchema;
  /** Bumped when the shape changes. Records don't name it: each is judged by the definition in force as of what it saw (spec 02 §6.3) */
  readonly version: number;
  /**
   * Whether edits to its records keep old versions. `latest` (the default)
   * keeps current state only; `all` keeps every version, hash-linked, as a
   * verifiable history. Read by writers, who mark each version accordingly.
   */
  readonly history?: 'latest' | 'all';
  /**
   * The link roles its records may carry, and what each may point at. An agent
   * reading the catalogue learns from these how the space's things connect.
   */
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  /**
   * What must be unique, which fields are fixed, whether records are
   * written once. Who may write is the space's grants, not the definition's
   * (spec 02 §7). A version is judged by the definition in force as of the
   * access changes it saw, on every peer.
   */
  readonly rules?: CollectionRules;
  /**
   * Fields whose values are topics: each record carries a keyed hash of each
   * value on its outside (`tags`), so a keeper that can't read the record can
   * still match "in #design" or "mentions me". It learns which records share
   * a topic, never which topic. At most 8; exact values only.
   */
  readonly topics?: ReadonlyArray<string>;
  /**
   * What a version must be to count: conditions (`check`) and whether the
   * collection is a line, one sequence per account at `lineKey(root,
   * collection)`. Judged by readers (spec 09); peers keep it and don't read it.
   */
  readonly contract?: CollectionContract;
  /**
   * Values derived from the records a node holds, the same way in every app:
   * counts of linked records, and filters over them. Not protocol: peers keep
   * it and never read it (packages/core/docs/computed.md).
   */
  readonly computed?: ComputedFields;
}

/** The reserved collection that collection definitions live in. */
export const CATALOG_COLLECTION = 'sys.collection';

const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'additionalProperties',
  'title',
  'description',
  'oneOf',
  'const',
  'x-choicesFrom',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
/** A collection's name: lower case, reverse-DNS, at least one dot */
export const COLLECTION_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Why a schema may not be published, or null when it may. */
export function checkPublishableSchema(schema: unknown, path = 'schema'): string | null {
  if (!isRecord(schema)) return `${path} must be an object`;
  for (const [keyword, value] of Object.entries(schema)) {
    const at = `${path}.${keyword}`;
    if (!KEYWORDS.has(keyword)) {
      return `${at} is not supported. Stored schemas may use: ${[...KEYWORDS].join(', ')}`;
    }
    switch (keyword) {
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || !types.every((t) => typeof t === 'string' && TYPES.has(t))) {
          return `${at} must be one of ${[...TYPES].join(', ')}`;
        }
        break;
      }
      case 'properties': {
        if (!isRecord(value)) return `${at} must be an object`;
        for (const [property, sub] of Object.entries(value)) {
          const problem = checkPublishableSchema(sub, `${at}.${property}`);
          if (problem) return problem;
        }
        break;
      }
      case 'items': {
        const problem = checkPublishableSchema(value, at);
        if (problem) return problem;
        break;
      }
      case 'required':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
          return `${at} must be a list of property names`;
        break;
      case 'enum':
        if (!Array.isArray(value) || value.length === 0) return `${at} must be a non-empty list`;
        break;
      case 'minimum':
      case 'maximum':
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`;
        break;
      case 'additionalProperties':
        if (typeof value !== 'boolean') return `${at} must be true or false`;
        break;
      case 'title':
      case 'description':
        if (typeof value !== 'string') return `${at} must be text`;
        break;
      case 'oneOf': {
        // Only labelled choices: [{ const, title? }]. Not general composition.
        if (!Array.isArray(value) || value.length === 0)
          return `${at} must be a non-empty list of { const, title }`;
        const choices: unknown[] = value;
        for (const [i, choice] of choices.entries()) {
          if (typeof choice !== 'object' || choice === null || !('const' in choice))
            return `${at}[${i}] must be { const, title }`;
          const extra = Object.keys(choice).find(
            (k) => k !== 'const' && k !== 'title' && k !== 'description',
          );
          if (extra)
            return `${at}[${i}].${extra}: oneOf is only for labelled choices — { const, title, description }`;
          if ('title' in choice && typeof choice.title !== 'string') return `${at}[${i}].title must be text`;
        }
        break;
      }
      case 'const':
        break;
      case 'x-choicesFrom': {
        const from = value;
        if (
          !isObject(from) ||
          typeof from.rel !== 'string' ||
          !LINK_REL_PATTERN.test(from.rel) ||
          typeof from.field !== 'string' ||
          !from.field
        ) {
          return `${at} must be { "rel": "<link role>", "field": "<list field in the linked record>" }`;
        }
        break;
      }
    }
  }
  return null;
}

/** Why a definition may not be published, or null when it may. */
export function checkStoredCollection(definition: unknown): string | null {
  const d = definition;
  if (!isObject(d)) return 'A collection definition must be an object';
  if (typeof d.name !== 'string' || !COLLECTION_NAME.test(d.name)) {
    return 'name must be reverse-DNS, lower case, with at least one dot — e.g. "app.todo.item"';
  }
  if (d.name.startsWith('sys.')) return '"sys.*" collections belong to the protocol';
  if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1)
    return 'version must be a whole number from 1';
  if (d.title !== undefined && typeof d.title !== 'string') return 'title must be text';
  if (d.description !== undefined && typeof d.description !== 'string') return 'description must be text';
  if (d.history !== undefined && d.history !== 'latest' && d.history !== 'all')
    return 'history must be "latest" or "all"';
  if (d.links !== undefined) {
    if (!isRecord(d.links)) return 'links must be an object of roles';
    for (const [rel, declaration] of Object.entries(d.links)) {
      if (!LINK_REL_PATTERN.test(rel)) return `Link role "${rel}" must be lower camel case, like "about"`;
      const decl = declaration;
      if (!isObject(decl)) return `links.${rel} must be an object`;
      const to = decl.to;
      if (to !== '*' && !(Array.isArray(to) && to.length > 0 && to.every((c) => typeof c === 'string'))) {
        return `links.${rel}.to must be "*" or a list of collection names`;
      }
      if (decl.cardinality !== undefined && decl.cardinality !== 'one' && decl.cardinality !== 'many') {
        return `links.${rel}.cardinality must be "one" or "many"`;
      }
      if (decl.description !== undefined && typeof decl.description !== 'string')
        return `links.${rel}.description must be text`;
    }
  }
  const rules = checkRules(d.rules, 'rules');
  if (rules) return rules;
  const topics = checkTopics(d.topics);
  if (topics) return topics;
  return checkPublishableSchema(d.schema);
}

export function isStoredCollection(definition: unknown): definition is StoredCollection {
  return checkStoredCollection(definition) === null;
}

export interface SchemaIssue {
  /** Where in the value, as a JSON pointer: `/items/0/text` */
  readonly path: string;
  readonly message: string;
}

const validators = new WeakMap<object, Validator>();

function newValidator(schema: unknown): Validator {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the library interprets any JSON Schema value; its type lists only the keywords it knows
  return new Validator(schema as Schema | boolean, '2020-12', false);
}

/**
 * One validator per schema object. It is built from a copy: the validator
 * writes into the schema it is given, and a stored schema is frozen.
 */
function validatorFor(schema: JsonSchema): Validator {
  if (typeof schema !== 'object' || schema === null) return newValidator(schema);
  let found = validators.get(schema);
  if (!found) {
    found = newValidator(structuredClone(schema));
    validators.set(schema, found);
  }
  return found;
}

/** Validates a value against a stored schema. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): ReadonlyArray<SchemaIssue> {
  const result = validatorFor(schema).validate(value);
  if (result.valid) return [];
  // The validator reports the wrapping keywords too ("properties" failed
  // because "text" did); the leaves are the useful part.
  const leaves = result.errors.filter((error) => error.keyword !== 'properties' && error.keyword !== 'items');
  return (leaves.length ? leaves : result.errors).map((error) => ({
    path: error.instanceLocation.replace(/^#/, '') || '/',
    message: error.error,
  }));
}

/** The first way a value breaks a schema, as `at.path: what`, or null when it fits */
export function schemaProblem(schema: JsonSchema, value: unknown, at = ''): string | null {
  const issue = validateJsonSchema(schema, value)[0];
  if (!issue) return null;
  const path = [at, ...issue.path.split('/').filter(Boolean)].filter(Boolean).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Wraps a stored schema as a Standard Schema, so gates and engines take it unchanged. */
export function asStandardSchema(schema: JsonSchema): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'minca/json-schema',
      validate(value: unknown) {
        const issues = validateJsonSchema(schema, value);
        return issues.length
          ? {
              issues: issues.map((issue) => ({
                message: issue.path === '/' ? issue.message : `${issue.path}: ${issue.message}`,
              })),
            }
          : { value };
      },
    },
  };
}
