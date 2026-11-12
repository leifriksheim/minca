/**
 * Sheets: collections of a space as tables, each seen through views everyone
 * in the space shares. The app draws it itself rather than in a screen, since
 * a screen sees only the collections its app names, and a sheet can show any.
 *
 * A view is a `sheets.view` record: which collection, named how, and how it
 * looks (`Look`). A collection is a table in the sheet while it has a view, so
 * adding a table writes its first view and removing one deletes them all. This
 * is the example app's own convention, like the launcher.
 */
import { fragments } from '@minca/core/schemas';
import { positionBetween } from '@minca/std';
import type { NodeRecord } from '@minca/core';
import { LAYOUTS, readLook, type Look } from '../../derive/look';
import { bodyOf } from '../../derive/schema-ui';
import type { LauncherApp } from '../apps/launcher';

export const SHEETS = 'sheets';

/** Whether an app is Sheets, by its template alone, as direct messages are */
export const isSheets = (body: LauncherApp | null | undefined): boolean => body?.template === SHEETS;

const MAX_NAME = 200;

export const sheetView = fragments.typed<Look & { title: string; collection: string; position?: string }>()({
  name: 'sheets.view',
  title: 'View',
  description: 'A saved way of looking at a collection in Sheets: as a table, a board or cards.',
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

/** A saved view as Sheets reads it: its record, its name and collection, where it sits, and its look */
export interface SheetView {
  readonly record: NodeRecord;
  readonly title: string;
  readonly collection: string;
  readonly position: string;
  readonly look: Look;
}

/** Every saved view in the sheet, in the order they sit */
export function readViews(records: ReadonlyArray<NodeRecord>): ReadonlyArray<SheetView> {
  return records
    .map((record) => ({ record, body: bodyOf(record) }))
    .flatMap(({ record, body }) =>
      typeof body.collection === 'string' && typeof body.title === 'string'
        ? [
            {
              record,
              title: body.title,
              collection: body.collection,
              position: typeof body.position === 'string' ? body.position : '',
              look: readLook(body),
            },
          ]
        : [],
    )
    .sort((a, b) => a.position.localeCompare(b.position));
}

/** The collections the sheet shows as tables, in the order they were added */
export const tablesOf = (views: ReadonlyArray<SheetView>): ReadonlyArray<string> => [
  ...new Set(views.map((view) => view.collection)),
];

/** A body for a new view, placed after every view there is */
export function newViewBody(
  collection: string,
  title: string,
  look: Look,
  views: ReadonlyArray<SheetView>,
): Record<string, unknown> {
  return { ...look, title, collection, position: positionBetween(views.at(-1)?.position || null) };
}
