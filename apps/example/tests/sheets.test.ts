/**
 * Sheets: a collection's look, kept on a device or saved in the space as a
 * `sheets.view` everyone shares, read back the same way whoever wrote it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FIRST_LOOK, readLook, type Look } from '../src/derive/look';
import { newViewBody, readViews, sheetView, tablesOf } from '../src/components/sheets/views';
import { shownFields, tableFields } from '../src/components/sheets/fields';
import { includesOf, linksWith, linksWithout, relatedRecords } from '../src/components/sheets/relations';
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

  test('a table has a column for the records its rows link to, and one for the records that link to them', async () => {
    const { alice, space } = await setup();
    const named = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } as const;
    await alice.node.collections.define(space, {
      name: 'app.organization',
      title: 'Organizations',
      schema: named,
    });
    await alice.node.collections.define(space, {
      name: 'app.place',
      title: 'Places',
      schema: named,
      links: { organization: { to: ['app.organization'], cardinality: 'one' } },
    });
    const co_op = await alice.node.records.put(space, 'app.organization', { name: 'The co-op' });
    await alice.node.records.put(space, 'app.organization', { name: 'Nobody yet' });
    const linked = { links: [{ rel: 'organization', to: co_op.key }] };
    const bakery = await alice.node.records.put(space, 'app.place', { name: 'Bakery' }, linked);
    await alice.node.records.put(space, 'app.place', { name: 'Garden' }, linked);
    await alice.node.records.put(space, 'app.place', { name: 'Shed' });

    const collections = await alice.node.collections.list(space);
    const columnsOf = (name: string) =>
      shownFields(
        tableFields(
          collections.find((c) => c.name === name)!,
          collections,
        ),
        undefined,
      );
    const titlesByRow = async (name: string, column: string) => {
      const columns = columnsOf(name);
      const { records } = await alice.node.records.query(space, {
        collection: name,
        include: includesOf(columns),
        sort: { name: 'asc' },
      });
      const shown = columns.find((c) => c.label === column)!;
      return records.map((row) => relatedRecords(row, shown).map((r) => bodyNameOf(r.body)));
    };

    assert.deepEqual(
      columnsOf('app.place').map((c) => c.label),
      ['Name', 'Organization'],
    );
    assert.deepEqual(await titlesByRow('app.place', 'Organization'), [['The co-op'], ['The co-op'], []]);
    assert.deepEqual(
      columnsOf('app.organization').map((c) => c.label),
      ['Name', 'Places'],
    );
    assert.deepEqual(await titlesByRow('app.organization', 'Places'), [[], ['Bakery', 'Garden']]);

    const guild = await alice.node.records.put(space, 'app.organization', { name: 'Bakers guild' });
    const organizationOf = columnsOf('app.place').find((c) => c.label === 'Organization')!.ownLink!;
    const relink = async (links: ReadonlyArray<{ rel: string; to: string }>) =>
      alice.node.records.update(space, bakery.key, bakery.body, { links });
    await relink(linksWith(bakery.links, organizationOf, guild.key));
    assert.deepEqual(
      await titlesByRow('app.place', 'Organization'),
      [['Bakers guild'], ['The co-op'], []],
      'a place has one organization, so linking another takes the place of the first',
    );
    await relink(linksWithout([{ rel: 'organization', to: guild.key }], 'organization', guild.key));
    assert.deepEqual(await titlesByRow('app.place', 'Organization'), [[], ['The co-op'], []]);
  });
});

const bodyNameOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && 'name' in body ? body.name : undefined;
