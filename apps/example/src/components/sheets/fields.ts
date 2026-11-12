/** A table's columns: which fields a sheet shows, how each is marked, and what a person can change in a cell. */
import type { NodeCollection } from '@minca/core';
import { FIELD_TYPE_INFO, fieldTypeOf } from '../../derive/field-types';
import {
  choicesFrom,
  choicesOf,
  computedFieldsOf,
  fieldsOf,
  isComputed,
  titleField,
  valueKindOf,
  type Field,
} from '../../derive/schema-ui';
import { linksInColumns, linksOutColumns, type Column } from './relations';

/**
 * Every column a table can show, its title first: the fields written and the records they link to, then the
 * fields worked out on this device and the records that link here
 */
export function tableFields(
  collection: NodeCollection,
  collections: ReadonlyArray<NodeCollection>,
): ReadonlyArray<Column> {
  const title = titleField(collection.schema);
  const written = fieldsOf(collection.schema);
  return [
    ...written.filter((f) => f.name === title),
    ...written.filter((f) => f.name !== title),
    ...linksOutColumns(collection),
    ...computedFieldsOf(collection, collections),
    ...linksInColumns(collection, collections),
  ];
}

/** Where a record sorts among the others: kept, but never worth a column */
const isPosition = (field: Field): boolean =>
  valueKindOf(field.schema) === 'position' || field.name === 'position';

/** The fields a view shows: those it picked, in its order, or else every one but where a record sorts */
export function shownFields(all: ReadonlyArray<Column>, picked: ReadonlyArray<string> | undefined) {
  if (!picked) return all.filter((f) => !isPosition(f));
  return picked.flatMap((name) => all.filter((f) => f.name === name));
}

/** The small mark in a column's head that says what kind it is: Aa, #, ◉, an arrow the way a link points; a row's title is always Aa */
export function fieldMark(field: Column, schema: NodeCollection['schema']): string {
  if (field.name === titleField(schema)) return FIELD_TYPE_INFO.text.mark;
  if (field.related) return field.related.direction === 'out' ? '→' : '←';
  if (isComputed(field)) return 'ƒ';
  const type = fieldTypeOf(field.schema);
  return type ? FIELD_TYPE_INFO[type].mark : '•';
}

/** What a cell can change where it is: one plain value, typed or picked. Anything richer opens the record */
export type CellEdit = 'text' | 'number' | 'choice' | 'check';

export function cellEditOf(field: Field): CellEdit | null {
  if (isComputed(field) || valueKindOf(field.schema)) return null;
  switch (field.kind) {
    case 'text':
    case 'longText':
      return 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'check';
    case 'choice':
      return choicesFrom(field.schema) ? null : 'choice';
    default:
      return null;
  }
}

/** The fields a board can make its columns from: those with a few fixed options */
export const groupableFields = (fields: ReadonlyArray<Field>): ReadonlyArray<Field> =>
  fields.filter((f) => cellEditOf(f) === 'choice');

/** One of the five hues, the same one for an option every time it shows: by its place among the field's options */
export function hueOf(field: Field, value: unknown): number {
  const at = choicesOf(field)?.findIndex((choice) => choice.value === value) ?? -1;
  return at >= 0 ? (at % 5) + 1 : hueOfText(String(value));
}

/** One of the five hues for a bit of text with no list of options to have a place in */
export function hueOfText(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 5) + 1;
}

/** Text as one line to read in a cell: Markdown's marks taken out, lines run together */
export function oneLine(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
