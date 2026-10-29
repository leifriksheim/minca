/**
 * @module node/space-catalog
 * The space's collections as their definitions describe them, and what a
 * body and its links are checked against. Which definition is in force for
 * each collection is the access history's answer: the latest change to
 * `collection:<name>` that counted.
 */
import type { Link, Version } from '../types.js';
import type { SchemaEngine } from '../schema/schema-engine.js';
import { checkLinks } from '../records/links.js';
import { checkContractShape, checkContracts, checkContractTypes, checkLine } from '../records/contracts.js';
import { checkComputed, checkComputedTypes, usableComputed } from '../query/computed.js';
import {
  checkStoredCollection,
  validateJsonSchema,
  type SchemaIssue,
  type StoredCollection,
} from '../schema/collection-def.js';
import type { NodeCollection } from './types.js';
import type { History } from './space-history.js';
import type { Rules } from './space-rules.js';

export interface CatalogEntry {
  readonly definition: StoredCollection;
  /** Null when rival first definitions name different accounts */
  readonly definedBy: string | null;
  /** The id of the version that holds this definition */
  readonly version: string;
}

/** Why a definition can't be stored, in the library's words; null when it can */
export function definitionProblem(
  definition: StoredCollection,
  described: ReadonlyMap<string, { readonly definition: StoredCollection }>,
): string | null {
  const { contract, computed } = definition;
  const shape = contract !== undefined ? checkContractShape(contract) : null;
  const line = contract?.line !== undefined ? checkLine(contract.line) : null;
  // A contract or computed field that misreads the schema is the library's own care, not protocol.
  const checks =
    contract?.check !== undefined
      ? (checkContracts(contract.check, 'contract.check') ??
        checkContractTypes(contract.check, definition.schema, 'contract.check'))
      : null;
  const linked = (name: string) =>
    name === definition.name ? definition : (described.get(name)?.definition ?? null);
  const fields =
    computed !== undefined
      ? (checkComputed(computed) ?? checkComputedTypes(definition.name, computed, definition.schema, linked))
      : null;
  return (
    checkStoredCollection(definition) ??
    (shape === 'unknown' ? 'contract takes only "check" and "line"' : shape) ??
    checks ??
    (line === 'unknown' ? 'contract.line takes only "once"' : line) ??
    fields
  );
}

export interface CatalogDeps {
  readonly schemas: SchemaEngine;
  readonly history: History;
  readonly rules: Rules;
  /** The version of a record that counts (`space-index.ts`): what a link points at */
  readonly currentOf: (recordKey: string) => Promise<Version | null>;
}

export function createCatalog({ schemas, history, rules, currentOf }: CatalogDeps) {
  const { access } = history;
  const { inForce, definitionIn } = rules;
  let catalogCache: Promise<Map<string, CatalogEntry>> | null = null;
  const catalog = () => (catalogCache ??= loadCatalog());

  async function loadCatalog(): Promise<Map<string, CatalogEntry>> {
    const result = new Map<string, CatalogEntry>();
    const { history } = await access();
    const { definitions, contested } = history.current;
    for (const name of new Set([...definitions.keys(), ...contested.keys()])) {
      const id = await inForce(history.current, name);
      const found = id ? await definitionIn(id) : 'missing';
      if (!id || typeof found === 'string') continue;
      if (found.definition.name !== name) continue;
      result.set(name, {
        definition: found.definition,
        definedBy: definitions.get(name)?.definedBy ?? null,
        version: id,
      });
    }
    return result;
  }

  /** A collection's definition: what the space says. The protocol knows no kinds of record of its own. */
  async function definitionOf(collection: string): Promise<StoredCollection | null> {
    return (await catalog()).get(collection)?.definition ?? null;
  }

  /** Issues with a body against its collection's schema; null when there is no schema to check against. */
  async function shapeIssues(collection: string, body: unknown): Promise<ReadonlyArray<SchemaIssue> | null> {
    // The protocol's own bookkeeping — definitions, profiles, roles — has no user-facing schema.
    if (collection.startsWith('sys.')) return null;
    const described = await definitionOf(collection);
    if (described) {
      // A schema the validator can't build (a bad $id in an annotation, say)
      // checks nothing, like a definition that is invalid (spec 02 §6.1).
      try {
        return validateJsonSchema(described.schema, body);
      } catch {
        return null;
      }
    }
    if (schemas.getCollection(collection)) {
      const checked = await schemas.validate(collection, body);
      return (checked.issues ?? []).map((issue) => ({ path: '/', message: issue.message }));
    }
    return null;
  }

  /**
   * Issues with a record's links against its collection's declaration. Only
   * what can be judged from what is held: a link to a record not here yet is
   * fine — you routinely hold a reaction before its post.
   */
  async function linkIssues(collection: string, links: ReadonlyArray<Link>): Promise<SchemaIssue[]> {
    const malformed = checkLinks(links);
    if (malformed) return [{ path: '/links', message: malformed }];
    if (links.length === 0) return [];
    const declared = (await definitionOf(collection))?.links;
    // An undescribed collection says nothing about its links, so nothing is wrong.
    if (!declared)
      return (await definitionOf(collection))
        ? [{ path: '/links', message: `${collection} declares no links` }]
        : [];

    const issues: SchemaIssue[] = [];
    const perRole = new Map<string, number>();
    for (const [index, link] of links.entries()) {
      const declaration = declared[link.rel];
      if (!declaration) {
        issues.push({
          path: `/links/${index}`,
          message: `${collection} has no "${link.rel}" link (it has: ${Object.keys(declared).join(', ')})`,
        });
        continue;
      }
      perRole.set(link.rel, (perRole.get(link.rel) ?? 0) + 1);
      if (declaration.to === '*') continue;
      const target = await currentOf(link.to);
      if (target && !target.deleted && !declaration.to.includes(target.collection)) {
        issues.push({
          path: `/links/${index}`,
          message: `"${link.rel}" must point at ${declaration.to.join(' or ')}, not ${target.collection}`,
        });
      }
    }
    for (const [rel, count] of perRole) {
      if (declared[rel]?.cardinality === 'one' && count > 1)
        issues.push({ path: '/links', message: `At most one "${rel}" link` });
    }
    return issues;
  }

  /** Shape and link issues together; null when neither has anything to check against. */
  async function contentIssues(
    collection: string,
    body: unknown,
    links: ReadonlyArray<Link>,
  ): Promise<ReadonlyArray<SchemaIssue> | null> {
    const shape = await shapeIssues(collection, body);
    const linked = await linkIssues(collection, links);
    if (shape === null && linked.length === 0 && !(await definitionOf(collection))) return null;
    return [...(shape ?? []), ...linked];
  }

  function describe(name: string, entry: CatalogEntry | null, records: number): NodeCollection {
    const definition = entry?.definition;
    const usable = usableComputed(definition?.computed, definition?.schema);
    return Object.freeze({
      name,
      ...(definition?.title !== undefined ? { title: definition.title } : {}),
      ...(definition?.description !== undefined ? { description: definition.description } : {}),
      schema: definition?.schema ?? null,
      version: definition?.version ?? null,
      history: definition?.history ?? 'latest',
      links: definition?.links ?? {},
      definedBy: entry?.definedBy ?? null,
      rules: definition?.rules ?? {},
      ...(definition?.contract !== undefined ? { contract: definition.contract } : {}),
      // Only what every reader can use: a definition written by hand arrives unchecked.
      ...(usable !== undefined ? { computed: usable } : {}),
      topics: definition?.topics ?? [],
      records,
    });
  }

  return {
    catalog,
    definitionOf,
    contentIssues,
    describe,
    forget(): void {
      catalogCache = null;
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
