/**
 * Sheets: every collection in a space as a table, a board, cards or a list,
 * with views everyone in the space shares. The app draws it itself rather than
 * in a screen, since a screen sees only the collections its app names, and
 * Sheets is for all of them, and for defining new ones.
 *
 * A view is a `sheets.view` record: which collection, named how, and how it
 * looks (`Look`). This is the example app's own convention, like the launcher.
 */
import { fragments, positionBetween } from '@minca/core/schemas';
import type { NodeRecord } from '@minca/core';
import { LAYOUTS, readLook, type Look } from '../../derive/look';
import { bodyOf } from '../../derive/schema-ui';
import type { LauncherApp } from './launcher';

export const SHEETS = 'sheets';

/** Whether an app is Sheets, by its template alone, as direct messages are */
export const isSheets = (body: LauncherApp | null | undefined): boolean => body?.template === SHEETS;

const MAX_NAME = 200;

export const sheetView = fragments.typed<Look & { title: string; collection: string; position?: string }>()({
  name: 'sheets.view',
  title: 'View',
  description: 'A saved way of looking at a collection in Sheets: as a table, a board, cards or a list.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      collection: { type: 'string', minLength: 1, maxLength: MAX_NAME },
      layout: { enum: LAYOUTS },
      groupBy: { type: 'string', minLength: 1, maxLength: MAX_NAME },
      fields: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: MAX_NAME } },
      sort: {
        type: 'object',
        properties: {
          field: { type: 'string', minLength: 1, maxLength: MAX_NAME },
          direction: { enum: ['asc', 'desc'] },
        },
        required: ['field', 'direction'],
      },
      filters: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', minLength: 1, maxLength: MAX_NAME },
            op: { type: 'string', minLength: 1, maxLength: 20 },
          },
          required: ['field', 'op'],
        },
      },
      position: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: ['title', 'collection', 'layout'],
  },
});

/** A saved view as Sheets reads it: its record, its name, where it sits among the others, and its look */
export interface SheetView {
  readonly record: NodeRecord;
  readonly title: string;
  readonly position: string;
  readonly look: Look;
}

/** The saved views of one collection, in the order they sit */
export function viewsOf(records: ReadonlyArray<NodeRecord>, collection: string): ReadonlyArray<SheetView> {
  return records
    .map((record) => ({ record, body: bodyOf(record) }))
    .filter(({ body }) => body.collection === collection && typeof body.title === 'string')
    .map(({ record, body }) => ({
      record,
      title: String(body.title),
      position: typeof body.position === 'string' ? body.position : '',
      look: readLook(body),
    }))
    .sort((a, b) => a.position.localeCompare(b.position));
}

/** A body for a new view, after the ones there are */
export function newViewBody(
  collection: string,
  title: string,
  look: Look,
  after: ReadonlyArray<SheetView>,
): Record<string, unknown> {
  return { ...look, title, collection, position: positionBetween(after.at(-1)?.position || null) };
}
