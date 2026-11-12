/** A table's relations as columns: the records each row links to, and the records that link to it. */
import type { Include, LinkDeclaration, NodeCollection, QueryRecord } from '@minca/core';
import { attachable, collectionLabel, humanize, type Field } from '../../derive/schema-ui';

/** A way a collection's own records may link: the role, and what its definition says of it */
export type OwnLink = LinkDeclaration & { readonly rel: string };

/**
 * A column of a table: a field of its records, or with `related`, the records each one is linked with.
 * `ownLink` is there when those links are the row's own, so changing the cell rewrites the row.
 */
export type Column = Field & { readonly related?: Include; readonly ownLink?: OwnLink };

/** How many linked records a cell asks for; the rest are on the record's own page */
const RELATED_PER_CELL = 10;

const relationColumn = (name: string, label: string, related: Include, ownLink?: OwnLink): Column => ({
  name,
  label,
  schema: {},
  kind: 'json',
  required: false,
  related: { ...related, limit: RELATED_PER_CELL },
  ...(ownLink ? { ownLink } : {}),
});

/** A column for each way the collection's records may link out: the organization a place is of */
export const linksOutColumns = (collection: NodeCollection): ReadonlyArray<Column> =>
  Object.entries(collection.links).map(([rel, declaration]) =>
    relationColumn(`link:${rel}`, humanize(rel), { rel, direction: 'out' }, { ...declaration, rel }),
  );

/** A column for each collection whose links name this one: the places of an organization */
export function linksInColumns(
  collection: NodeCollection,
  collections: ReadonlyArray<NodeCollection>,
): ReadonlyArray<Column> {
  const namingThisOne = attachable(collections, collection.name).filter(
    ({ collection: from, rel }) => from.version !== null && from.links[rel]?.to !== '*',
  );
  return namingThisOne.map(({ collection: from, rel }) => {
    const isItsOnlyLinkHere = namingThisOne.filter((other) => other.collection === from).length === 1;
    const label = collectionLabel(from);
    return relationColumn(
      `from:${from.name}:${rel}`,
      isItsOnlyLinkHere ? label : `${label} · ${humanize(rel).toLowerCase()}`,
      { rel, from: from.name },
    );
  });
}

/** The query `include` that brings each relation column's records along with a row, under the column's name */
export const includesOf = (columns: ReadonlyArray<Column>): Readonly<Record<string, Include>> =>
  Object.fromEntries(columns.flatMap((column) => (column.related ? [[column.name, column.related]] : [])));

/** The records a row is linked with in a relation column */
export function relatedRecords(record: QueryRecord, column: Column): ReadonlyArray<QueryRecord> {
  const found = record.included[column.name];
  return found === undefined || typeof found === 'number' ? [] : found;
}

type Links = QueryRecord['links'];

/** A record's links with one more to `to`, which takes the place of the one before where there may be only one */
export const linksWith = (links: Links, { rel, cardinality }: OwnLink, to: string): Links => [
  ...(cardinality === 'one' ? links.filter((link) => link.rel !== rel) : links),
  { rel, to },
];

/** A record's links less the one to `to` in this role */
export const linksWithout = (links: Links, rel: string, to: string): Links =>
  links.filter((link) => !(link.rel === rel && link.to === to));
