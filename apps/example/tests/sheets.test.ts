/**
 * Sheets: a collection's look, kept on a device or saved in the space as a
 * `sheets.view` everyone shares, read back the same way whoever wrote it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FIRST_LOOK, readLook, type Look } from '../src/derive/look';
import { newViewBody, readViews, sheetView, tablesOf } from '../src/components/sheets/views';
import { addTemplate, type Template } from '../src/components/apps/launcher';
import { setup } from './helpers';

/** Sheets as `templates/index.ts` has it, which these tests can't load for its screens */
const SHEETS: Template = {
  app: { template: 'sheets', title: 'Sheets', description: 'Tables', collections: [sheetView.name] },
  needs: [sheetView],
};

describe('Sheets', () => {
  test('a look read from a record keeps what it understands and leaves out the rest', () => {
    assert.deepEqual(readLook(null), FIRST_LOOK);
    assert.deepEqual(
      readLook({
        layout: 'spreadsheet',
        groupBy: 'status',
        fields: ['title', 3],
        sort: { field: 'title', direction: 'sideways' },
        filters: [{ field: 'status', op: 'is', value: 'done' }, { field: 'status', op: 'resembles' }, 'done'],
      }),
      { layout: 'table', groupBy: 'status', filters: [{ field: 'status', op: 'is', value: 'done' }] },
    );
  });

  test('adding Sheets defines its views; saved views read back as saved, and the tables they make in the order they came', async () => {
    const { alice, space } = await setup();
    await addTemplate(alice.node, space, SHEETS, []);
    assert.ok((await alice.node.collections.list(space)).some((c) => c.name === sheetView.name));

    const board: Look = {
      layout: 'board',
      groupBy: 'status',
      fields: ['title', 'due'],
      sort: { field: 'due', direction: 'asc' },
      filters: [{ field: 'status', op: 'isNot', value: 'done' }],
    };
    const put = async (collection: string, title: string, look: Look) => {
      const before = readViews(await alice.node.records.list(space, { collection: sheetView.name }));
      await alice.node.records.put(space, sheetView.name, newViewBody(collection, title, look, before));
    };
    await put('std.task', 'Open work', board);
    await put('std.event', 'Calendar', board);
    await put('std.task', 'Everything', { layout: 'table' });

    const views = readViews(await alice.node.records.list(space, { collection: sheetView.name }));
    assert.deepEqual(tablesOf(views), ['std.task', 'std.event'], 'tables in the order they were added');
    assert.deepEqual(
      views.filter((v) => v.collection === 'std.task').map((v) => v.title),
      ['Open work', 'Everything'],
    );
    assert.deepEqual(views[0]?.look, board);
  });
});
