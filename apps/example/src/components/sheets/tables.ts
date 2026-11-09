/** Making a table of one's own, and adding a column to one: both are collection definitions, written as anyone would. */
import type { JsonSchema, NodeCollection, P2PNode } from '@minca/core';
import { fieldSchema, type FieldTypeName } from '../../derive/field-types';
import { isObject } from '../../derive/schema-ui';
import { offLimits } from '@minca/app-shared/screens';
import { sheetView } from './views';

/** What a new table starts with: a name for each row, notes, and a status to make a board from */
const FIRST_COLUMNS: Readonly<Record<string, JsonSchema>> = {
  name: { type: 'string', title: 'Name', minLength: 1, maxLength: 500 },
  notes: { type: 'string', title: 'Notes', maxLength: 10000 },
  status: { type: 'string', title: 'Status', enum: ['To do', 'Doing', 'Done'] },
};

/** `field-name` as stored, from what a person called it */
const slugOf = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A name not yet taken: `base`, or `base-2`, `base-3`… */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Defines a new collection for a table called `title`, and gives its name */
export async function defineTable(
  node: P2PNode,
  spaceId: string,
  title: string,
  collections: ReadonlyArray<NodeCollection>,
): Promise<string> {
  const name = freeName(`app.${slugOf(title) || 'table'}`, new Set(collections.map((c) => c.name)));
  await node.collections.define(spaceId, {
    name,
    title: title.trim(),
    schema: { type: 'object', properties: FIRST_COLUMNS, required: ['name'] },
  });
  return name;
}

/** Defines a collection again with one more field, keeping everything else it says */
export async function addColumn(
  node: P2PNode,
  spaceId: string,
  collection: NodeCollection,
  label: string,
  type: FieldTypeName,
  options: ReadonlyArray<string>,
): Promise<void> {
  const schema = collection.schema ?? { type: 'object' };
  const properties = isObject(schema.properties) ? schema.properties : {};
  const name = freeName(slugOf(label) || 'field', new Set(Object.keys(properties)));
  await node.collections.define(spaceId, {
    name: collection.name,
    ...(collection.title ? { title: collection.title } : {}),
    ...(collection.description ? { description: collection.description } : {}),
    schema: {
      ...schema,
      properties: { ...properties, [name]: { ...fieldSchema(type, options), title: label.trim() } },
    },
    history: collection.history,
    links: collection.links,
    rules: collection.rules,
    ...(collection.contract ? { contract: collection.contract } : {}),
    ...(collection.computed ? { computed: collection.computed } : {}),
    ...(collection.topics.length ? { topics: collection.topics } : {}),
  });
}

/**
 * The collections someone can add to a sheet as a table: those defined in the
 * space, the space's own first. Not the space's workings, nor the sheet's own
 * views, nor direct messages, which are sealed for the people they're to.
 */
export function addableCollections(
  collections: ReadonlyArray<NodeCollection>,
): ReadonlyArray<NodeCollection> {
  return collections
    .filter(
      (c) =>
        c.version !== null &&
        c.schema !== null &&
        !offLimits(c.name) &&
        c.name !== sheetView.name &&
        c.name !== 'std.direct',
    )
    .sort((a, b) => Number(a.name.startsWith('std.')) - Number(b.name.startsWith('std.')));
}
