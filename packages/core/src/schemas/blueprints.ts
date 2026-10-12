/**
 * Blueprints: collections someone proposes for a space, before anyone
 * defines them.
 *
 * Anyone in a space may write one `std.blueprint` record: a title, a line on
 * what it is for, and the collections it would add, each as a full
 * definition. Nothing is defined yet, so a blueprint can't break anything.
 * Someone allowed to define collections reads what it would do (in sentences
 * worked out from its rules, `describeCollection`) and applies it: their node
 * defines each collection, signed by them.
 *
 * It is how a key that may only write records asks for new collections: an
 * agent's, whose note grants records only, or a person's, whose role doesn't
 * let them define. Nothing here is about apps. An app that keeps more about
 * itself, such as a screen or what to notify about, keeps that in records of
 * its own that point at the blueprint.
 *
 * A changed blueprint is a new one that names the one it `updates`. Once the
 * update is applied, the one it replaced is superseded: applying it would
 * only undo the update, so it is not offered again.
 */
import type { NodeCollection, NodeRecord, P2PNode } from '../node/types.js';
import {
  checkStoredCollection,
  isStoredCollection,
  schemaProblem,
  toJsonSchema,
} from '../schema/collection-def.js';
import { standardDefinition } from './standard.js';
import { isObject } from '../utils/guards.js';
import { canonicalize } from '../schema/version.js';
import { describeCollection } from '../records/describe.js';
import { blueprint, type Blueprint, type DraftCollection } from './library/collections.js';

/** Why this can't be a blueprint, or null when it can */
export function checkBlueprint(value: unknown): string | null {
  if (!isObject(value)) return 'A blueprint must be an object';
  const shape = schemaProblem(blueprint.schema, value);
  if (shape) return shape;
  if (typeof value.title !== 'string' || !value.title.trim()) return 'A blueprint needs a title';
  const given: unknown[] = Array.isArray(value.collections) ? value.collections : [];
  const names = new Set<string>();
  for (const [index, draft] of given.entries()) {
    const at = `collections[${index}]`;
    if (!isObject(draft)) return `${at} must be a collection definition`;
    if (typeof draft.name === 'string' && draft.name.startsWith('sys.'))
      return `${at}: sys.* collections are the protocol's own`;
    if ('version' in draft) return `${at}: leave out "version": the space decides it when it is applied`;
    const stored = { ...draft, version: 1 };
    if (!isStoredCollection(stored)) return `${at}: ${checkStoredCollection(stored)}`;
    if (names.has(stored.name)) return `${at}: ${stored.name} is listed twice`;
    names.add(stored.name);
    try {
      describeCollection(stored);
    } catch (error) {
      return `${at}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/** The parts of a definition that say what it is, rather than what it is called */
const SHAPE = ['schema', 'history', 'links', 'rules', 'topics'] as const;

/**
 * Collections as a proposer gives them: each a definition, or the name of a
 * standard one (`"std.poll"`) to use exactly as the library has it. A
 * `std.*` name means the standard thing, so a definition that names one must
 * be the library's; only its `title` and `description` may be its own.
 * Throws saying which one is wrong and what to do instead.
 */
export function standardCollections(collections: unknown): unknown {
  if (!Array.isArray(collections)) return collections;
  const given: unknown[] = collections;
  return given.map((draft, index) => {
    const at = `collections[${index}]`;
    const name = typeof draft === 'string' ? draft : isObject(draft) ? draft.name : undefined;
    if (typeof name !== 'string' || !name.startsWith('std.')) return draft;
    const standard = standardDefinition(name);
    if (!standard) {
      throw new Error(
        `${at}: ${name} is not in the standard library, and std.* names are only its. ` +
          'Name a collection of your own after what it is for, like "carpool.ride".',
      );
    }
    const library: DraftCollection = {
      name: standard.name,
      schema: toJsonSchema(standard.schema),
      ...(standard.title !== undefined ? { title: standard.title } : {}),
      ...(standard.description !== undefined ? { description: standard.description } : {}),
      ...(standard.history !== undefined ? { history: standard.history } : {}),
      ...(standard.links !== undefined ? { links: standard.links } : {}),
      ...(standard.rules !== undefined ? { rules: standard.rules } : {}),
      ...(standard.topics !== undefined ? { topics: standard.topics } : {}),
    };
    if (typeof draft === 'string') return library;
    if (!isObject(draft)) return draft;
    const theirs = essence({
      schema: draft.schema,
      history: typeof draft.history === 'string' ? draft.history : undefined,
      links: draft.links,
      rules: draft.rules,
      topics: Array.isArray(draft.topics)
        ? draft.topics.filter((t): t is string => typeof t === 'string')
        : undefined,
    });
    const ours = essence(library);
    if (!SHAPE.every((part) => theirs[part] === ours[part])) {
      throw new Error(
        `${at}: ${name} is the standard ${standard.title ?? name}, and this is a different shape. ` +
          `Pass "${name}" to use it as it is, or name your own after what it is for.`,
      );
    }
    return {
      ...library,
      ...(typeof draft.title === 'string' ? { title: draft.title } : {}),
      ...(typeof draft.description === 'string' ? { description: draft.description } : {}),
    };
  });
}

/** What applying one collection would do in a space */
export interface CollectionReview {
  readonly definition: DraftCollection;
  /** `new`: not in the space yet. `same`: already there, as is. `change`: there, and this would change it. */
  readonly status: 'new' | 'same' | 'change';
  /** What it allows, from its rules, never from its description */
  readonly summary: ReadonlyArray<string>;
  /** For a change: what would be different, in words */
  readonly changes: ReadonlyArray<string>;
  /**
   * For a change: the titles of the applied blueprints that need this
   * collection as the space has it now, which the change could break. Empty
   * when the review was not given the space's blueprints.
   */
  readonly usedBy: ReadonlyArray<string>;
}

/** The space's blueprints, so a review can say which of them a change would touch */
export interface ReviewContext {
  /** Every blueprint in the space */
  readonly blueprints: ReadonlyArray<NodeRecord<Blueprint>>;
  /** The key of the one under review, when it is already a record, so it doesn't count itself */
  readonly key?: string;
}

export interface BlueprintReview {
  readonly collections: ReadonlyArray<CollectionReview>;
  /** Every collection it proposes is in the space, as it says */
  readonly applied: boolean;
  /** Why it can't be applied as it stands, or null */
  readonly problem: string | null;
}

/** The parts of a definition that decide what it is, in one comparable form */
function essence(definition: {
  title?: string | undefined;
  description?: string | undefined;
  schema: unknown;
  history?: string | undefined;
  links?: unknown;
  rules?: unknown;
  topics?: ReadonlyArray<string> | undefined;
}) {
  return {
    title: definition.title ?? '',
    description: definition.description ?? '',
    schema: canonicalize(definition.schema ?? null),
    history: definition.history ?? 'latest',
    links: canonicalize(definition.links ?? {}),
    rules: canonicalize(definition.rules ?? {}),
    topics: canonicalize([...(definition.topics ?? [])].sort()),
  };
}

const fieldNames = (schema: unknown) =>
  Object.keys((isObject(schema) && isObject(schema.properties) ? schema.properties : null) ?? {});

/** What would change, in words, going from what the space has to what the blueprint says */
function differences(held: NodeCollection, wanted: DraftCollection): string[] {
  const a = essence(held);
  const b = essence(wanted);
  const out: string[] = [];
  const before = new Set(fieldNames(held.schema));
  const after = new Set(fieldNames(wanted.schema));
  const added = [...after].filter((field) => !before.has(field));
  const removed = [...before].filter((field) => !after.has(field));
  if (added.length) out.push(`adds ${added.map((f) => `“${f}”`).join(', ')}`);
  if (removed.length) out.push(`drops ${removed.map((f) => `“${f}”`).join(', ')}`);
  if (!added.length && !removed.length && a.schema !== b.schema) out.push('changes the shape of its fields');
  if (a.rules !== b.rules) out.push('changes what its records must keep to');
  if (a.links !== b.links) out.push('changes what it points at');
  if (a.topics !== b.topics) out.push('changes what can be matched without reading it');
  if (a.history !== b.history)
    out.push(b.history === 'all' ? 'starts keeping every version' : 'stops keeping old versions');
  if (a.title !== b.title || a.description !== b.description) out.push('renames or redescribes it');
  return out;
}

/**
 * What applying a blueprint would do in a space: which of its collections are
 * new, already there, or would change one that is, each with what it allows.
 */
export function reviewBlueprint(
  body: Blueprint,
  collections: ReadonlyArray<NodeCollection>,
  context?: ReviewContext,
): BlueprintReview {
  const problem = checkBlueprint(body);
  if (problem) return { collections: [], applied: false, problem };
  const byName = new Map(collections.filter((c) => c.version !== null).map((c) => [c.name, c]));
  const inUse = context ? applied(context.blueprints, collections, [context.key, body.updates]) : [];
  const reviews = body.collections.map((definition): CollectionReview => {
    const summary = describeCollection(definition);
    const held = byName.get(definition.name);
    if (!held) return { definition, status: 'new', summary, changes: [], usedBy: [] };
    const changes = metByLibrary(held, definition) ? [] : differences(held, definition);
    const usedBy = changes.length
      ? inUse
          .filter((other) => other.collections.some((c) => c.name === definition.name))
          .map((other) => other.title)
      : [];
    return { definition, status: changes.length ? 'change' : 'same', summary, changes, usedBy };
  });
  return { collections: reviews, applied: reviews.every((r) => r.status === 'same'), problem: null };
}

/**
 * Whether a standard collection is met by what the space holds because the
 * space holds the library's current definition of it. The library only adds
 * to its definitions, so a blueprint made against an earlier one still works
 * with it, and offering the earlier one back would only take the additions
 * away.
 */
function metByLibrary(held: NodeCollection, wanted: DraftCollection): boolean {
  if (!wanted.name.startsWith('std.')) return false;
  const standard = standardDefinition(wanted.name);
  if (!standard) return false;
  const library = essence({ ...standard, schema: toJsonSchema(standard.schema) });
  const space = essence(held);
  return SHAPE.every((part) => space[part] === library[part]);
}

/** The blueprints applied and not replaced since, leaving out the ones named in `except` */
function applied(
  records: ReadonlyArray<NodeRecord<Blueprint>>,
  collections: ReadonlyArray<NodeCollection>,
  except: ReadonlyArray<string | undefined>,
): ReadonlyArray<Blueprint> {
  const superseded = supersededBlueprints(records, collections);
  return records.flatMap((record) =>
    record.body &&
    !except.includes(record.key) &&
    !superseded.has(record.key) &&
    reviewBlueprint(record.body, collections).applied
      ? [record.body]
      : [],
  );
}

/**
 * The blueprints a newer version has replaced: each one that an applied
 * blueprint `updates`, and, through it, each one that one replaced in turn.
 * Applying one of these would only undo the update.
 */
export function supersededBlueprints(
  records: ReadonlyArray<NodeRecord<Blueprint>>,
  collections: ReadonlyArray<NodeCollection>,
): ReadonlySet<string> {
  const replaces = new Map<string, string>();
  for (const record of records) {
    if (record.body?.updates && record.body.updates !== record.key)
      replaces.set(record.key, record.body.updates);
  }
  const superseded = new Set<string>();
  for (const record of records) {
    if (!record.body || !reviewBlueprint(record.body, collections).applied) continue;
    // Walk back from each applied one; the guard stops at a loop.
    for (
      let key = replaces.get(record.key);
      key && !superseded.has(key) && key !== record.key;
      key = replaces.get(key)
    )
      superseded.add(key);
  }
  return superseded;
}

/**
 * Proposes collections for a space: one `std.blueprint` record. Anyone in
 * the space may propose; nothing is defined until someone who may applies it.
 */
export async function proposeCollections(
  node: P2PNode,
  spaceId: string,
  body: Blueprint,
): Promise<NodeRecord<Blueprint>> {
  const problem = checkBlueprint(body);
  if (problem) throw new Error(problem);
  if (body.updates) {
    const replaced = await node.records.get(spaceId, body.updates);
    if (!replaced || replaced.collection !== blueprint.name)
      throw new Error(`"updates" names no blueprint in this space: ${body.updates}`);
  }
  return node.records.put<Blueprint>(spaceId, blueprint.name, body);
}

/**
 * Applies a blueprint: defines each collection it proposes that the space
 * doesn't have as it says, new ones and changes to ones it has. Signed by
 * whoever applies it, so they must be allowed to define collections here,
 * by their role and by their key's note.
 */
export async function applyBlueprint(node: P2PNode, spaceId: string, key: string): Promise<BlueprintReview> {
  const record = await node.records.get<Blueprint>(spaceId, key);
  if (!record?.body || record.collection !== blueprint.name)
    throw new Error(`No blueprint ${key} in this space`);
  const known = await node.collections.list(spaceId);
  const review = reviewBlueprint(record.body, known);
  if (review.problem) throw new Error(review.problem);
  const blueprints = await node.records.list<Blueprint>(spaceId, { collection: blueprint.name });
  if (supersededBlueprints(blueprints, known).has(key))
    throw new Error('A newer version of this blueprint has been applied; applying this one would undo it');
  // Knowing std.blueprint itself means its own rules hold from now on: only its proposer edits it.
  if (!known.some((c) => c.name === blueprint.name && c.version !== null))
    await node.collections.define(spaceId, blueprint);
  for (const one of review.collections) {
    if (one.status === 'same') continue;
    await node.collections.define(spaceId, one.definition);
  }
  return reviewBlueprint(record.body, await node.collections.list(spaceId));
}

/** Copies a blueprint into another space, as a proposal there: people in that space decide for themselves. */
export async function copyBlueprint(
  node: P2PNode,
  fromSpace: string,
  key: string,
  toSpace: string,
): Promise<NodeRecord<Blueprint>> {
  const record = await node.records.get<Blueprint>(fromSpace, key);
  if (!record?.body || record.collection !== blueprint.name)
    throw new Error(`No blueprint ${key} in this space`);
  const { title, description, collections } = record.body;
  return proposeCollections(node, toSpace, {
    title,
    ...(description !== undefined ? { description } : {}),
    collections,
    from: `${fromSpace}/${key}`,
  });
}
