import { useState } from 'react';
import type { NodeCollection, NodeRecord, P2PNode, SpaceSummary } from '@minca/core';
import { useLive, useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Icon } from '@minca/app-shared/Icon';
import { Loader } from '@minca/app-shared/Loader';
import { useMayDefine } from '@minca/app-shared/may';
import { collectionLabel } from '../../derive/schema-ui';
import { FIRST_LOOK } from '../../derive/look';
import { useRemembered } from '../../kept';
import { usePopover } from '../usePopover';
import { SheetTable } from './SheetTable';
import { addableCollections, defineTable } from './tables';
import { newViewBody, readViews, sheetView, tablesOf, type SheetView } from './views';
import styles from './Sheets.module.css';

/**
 * Sheets: the tables someone put in it, as tabs, the open one under them.
 * It starts empty, and a table is either a collection the space already
 * keeps, or a new one made here.
 */
export function Sheets({
  space,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const records = useLive(space.id, (n) => n.records.list(space.id, { collection: sheetView.name }), []);
  const [pickedTable, setPickedTable] = useRemembered(`minca.sheet:${space.id}`);
  const { run, error } = useAction();
  if (!records) return <Loader />;

  const views = readViews(records);
  const tables = tablesOf(views).flatMap((name) => collections.filter((c) => c.name === name));
  const table = tables.find((c) => c.name === pickedTable) ?? tables[0] ?? null;
  const notYetTables = addableCollections(collections).filter((c) => !tables.includes(c));

  const addTable = (name: string) =>
    run(async () => {
      await putFirstView(node, space.id, name, views);
      setPickedTable(name);
    });
  const makeTable = (title: string) =>
    run(async () => {
      const name = await defineTable(node, space.id, title, collections);
      await putFirstView(node, space.id, name, views);
      setPickedTable(name);
    });
  const removeTable = (name: string) =>
    run(async () => {
      for (const view of views.filter((v) => v.collection === name))
        await node.records.delete(space.id, view.record.key);
    });

  if (!table)
    return (
      <div className={styles.sheet}>
        <StartSheet space={space} addable={notYetTables} onAdd={addTable} onMake={makeTable} />
        {error && <p role="alert">{error}</p>}
      </div>
    );

  return (
    <div className={styles.sheet}>
      <nav className={styles.tables} aria-label="Tables">
        {tables.map((c) => (
          <TableTab
            key={c.name}
            collection={c}
            selected={c === table}
            onSelect={() => setPickedTable(c.name)}
            onRemove={space.writable ? () => removeTable(c.name) : undefined}
          />
        ))}
        {space.writable && (
          <AddTable space={space} addable={notYetTables} onAdd={addTable} onMake={makeTable} />
        )}
      </nav>
      {error && <p role="alert">{error}</p>}
      <SheetTable
        key={table.name}
        space={space}
        collection={table}
        collections={collections}
        views={views.filter((v) => v.collection === table.name)}
        allViews={views}
        onOpen={onOpen}
      />
    </div>
  );
}

/** A table joins the sheet with its first view: everything, as a table */
const putFirstView = (node: P2PNode, spaceId: string, collection: string, views: ReadonlyArray<SheetView>) =>
  node.records.put(spaceId, sheetView.name, newViewBody(collection, 'All', FIRST_LOOK, views));

/** An empty sheet: make a table, or show one the space already keeps */
function StartSheet({
  space,
  addable,
  onAdd,
  onMake,
}: {
  space: SpaceSummary;
  addable: ReadonlyArray<NodeCollection>;
  onAdd: (name: string) => Promise<unknown>;
  onMake: (title: string) => Promise<unknown>;
}) {
  const mayMake = useMayDefine(space.id);
  return (
    <div className={styles.start}>
      <h1>Start your sheet</h1>
      <p>Make a table of your own, or put in one of the things your group already keeps.</p>
      {mayMake && <NewTableForm onMake={onMake} />}
      {addable.length > 0 && (
        <>
          <small className={styles.heading}>Already in {space.name ?? 'this space'}</small>
          <div className={styles.tiles}>
            {addable.map((c) => (
              <button key={c.name} className={styles.tile} onClick={() => void onAdd(c.name)}>
                <Icon name="table" size={16} />
                <strong>{collectionLabel(c)}</strong>
                <small>{c.records === 1 ? '1 row' : `${c.records} rows`}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A name for a new table, and Create */
function NewTableForm({ onMake }: { onMake: (title: string) => Promise<unknown> }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className={styles.newTable}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) void onMake(title.trim());
      }}
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Name a new table: Recipes, Gear, Clients…"
        aria-label="New table name"
        maxLength={100}
      />
      <button type="submit" data-intent="primary" disabled={!title.trim()}>
        Create
      </button>
    </form>
  );
}

/** A table's tab. Pressed again once open, it offers to take the table out of the sheet; its records stay */
function TableTab({
  collection,
  selected,
  onSelect,
  onRemove,
}: {
  collection: NodeCollection;
  selected: boolean;
  onSelect: () => void;
  onRemove: (() => Promise<unknown>) | undefined;
}) {
  const { open, setOpen, close, root } = usePopover();
  return (
    <div ref={root} className={styles.popoverAnchor}>
      <button
        className={styles.tableTab}
        aria-current={selected ? 'page' : undefined}
        onClick={() => (selected && onRemove ? setOpen((was) => !was) : onSelect())}
      >
        {collectionLabel(collection)}
        {selected && onRemove && <Icon name="down" size={12} />}
      </button>
      {open && onRemove && (
        <div className={`${styles.popover} ${styles.choices}`} data-align="start">
          <button
            onClick={() => {
              close();
              void onRemove();
            }}
          >
            <Icon name="close" size={14} />
            Take out of the sheet
          </button>
          <small className={styles.note}>Its rows stay in the space.</small>
        </div>
      )}
    </div>
  );
}

/** "+" after the tables: a new one, or one the space already keeps */
function AddTable({
  space,
  addable,
  onAdd,
  onMake,
}: {
  space: SpaceSummary;
  addable: ReadonlyArray<NodeCollection>;
  onAdd: (name: string) => Promise<unknown>;
  onMake: (title: string) => Promise<unknown>;
}) {
  const { open, setOpen, close, root } = usePopover();
  const mayMake = useMayDefine(space.id);
  return (
    <div ref={root} className={styles.popoverAnchor}>
      <button
        className={styles.tool}
        onClick={() => setOpen((was) => !was)}
        aria-label="Add a table"
        aria-expanded={open}
      >
        <Icon name="plus" size={14} />
      </button>
      {open && (
        <div className={styles.popover} data-align="start">
          {mayMake && <NewTableForm onMake={(title) => onMake(title).then(close)} />}
          {addable.length > 0 && (
            <div className={styles.choices}>
              <small className={styles.heading}>Already in {space.name ?? 'this space'}</small>
              {addable.map((c) => (
                <button
                  key={c.name}
                  onClick={() => {
                    close();
                    void onAdd(c.name);
                  }}
                >
                  <Icon name="table" size={14} />
                  {collectionLabel(c)}
                  <small>{c.records}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
