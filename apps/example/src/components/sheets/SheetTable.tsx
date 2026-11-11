import { useDeferredValue, useState } from 'react';
import type { Filter, NodeCollection, NodeRecord, QueryRecord, SpaceSummary } from '@minca/core';
import { useAccount, useLive, useNode, useProfiles } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Icon, type IconName } from '@minca/app-shared/Icon';
import { Modal } from '@minca/app-shared/Modal';
import { useMayDefine } from '@minca/app-shared/may';
import { whereOf } from '../../derive/conditions';
import { NEWEST_FIRST } from '../../derive/filters';
import { LAYOUT_LABELS, LAYOUTS, type Layout, type Look } from '../../derive/look';
import { peopleFrom } from '../../derive/people';
import { bodyOf, quickAddBody, titleField, type Field } from '../../derive/schema-ui';
import { useRemembered } from '../../kept';
import { SchemaForm } from '../SchemaForm';
import { usePopover } from '../usePopover';
import { AddColumn } from './AddColumn';
import { Board } from './Board';
import { Gallery } from './Gallery';
import { Grid } from './Grid';
import { cellEditOf, groupableFields, shownFields, tableFields } from './fields';
import type { LayoutProps } from './layout';
import { Toolbar } from './Toolbar';
import { Panel } from './Popover';
import { newViewBody, sheetView, type SheetView } from './views';
import styles from './Sheets.module.css';

const LAYOUT_ICONS: Readonly<Record<Layout, IconName>> = { table: 'table', board: 'board', cards: 'card' };

/** How many records a view shows at first, and how many more each "Show more" adds */
const PAGE = 100;

/** One table of the sheet: its views as tabs, and the open one's records, laid out as it says */
export function SheetTable({
  space,
  collection,
  collections,
  views,
  allViews,
  onOpen,
}: {
  space: SpaceSummary;
  collection: NodeCollection;
  collections: ReadonlyArray<NodeCollection>;
  /** This table's views */
  views: ReadonlyArray<SheetView>;
  /** Every view in the sheet, which a new one goes after */
  allViews: ReadonlyArray<SheetView>;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const people = peopleFrom(useProfiles(space.id));
  const [pickedKey, setPickedKey] = useRemembered(`minca.sheet:${space.id}:${collection.name}`);
  const view = views.find((v) => v.record.key === pickedKey) ?? views[0];
  const { run, error } = useAction();
  const [adding, setAdding] = useState<Record<string, unknown> | null>(null);
  const mayAddColumns = useMayDefine(space.id, collection.name);
  const [search, setSearch] = useState('');

  const look = view?.look ?? { layout: 'table' };
  const all = tableFields(collection, collections);
  const fields = shownFields(all, look.fields);
  const groupable = groupableFields(all);
  const group = groupable.find((f) => f.name === look.groupBy) ?? groupable[0] ?? null;
  const searchableFields = fields.filter((f) => cellEditOf(f) === 'text');
  const searchWhere = searchFilterOf(useDeferredValue(search), searchableFields);
  const { rows, more, showMore } = useRows(space.id, collection.name, look, searchWhere);

  const saveLook = (next: Look) => {
    if (view)
      void run(() => node.records.update(space.id, view.record.key, { ...bodyOf(view.record), ...next }));
  };
  const addView = (layout: Layout) =>
    run(async () => {
      const added = await node.records.put(
        space.id,
        sheetView.name,
        newViewBody(collection.name, LAYOUT_LABELS[layout], { ...look, layout }, allViews),
      );
      setPickedKey(added.key);
    });
  const save = (record: QueryRecord, field: Field, value: unknown) =>
    void run(() => node.records.update(space.id, record.key, withValue(bodyOf(record), field.name, value)));
  /** Adds a record from its title at once, or opens the whole form when something else must be filled in */
  const add = async (values: Readonly<Record<string, unknown>>, title: string) => {
    const quick = quickAddBody(collection.schema, title);
    if (quick) {
      await run(() => node.records.put(space.id, collection.name, { ...quick, ...values }));
      return;
    }
    const name = titleField(collection.schema);
    setAdding({ ...values, ...(name ? { [name]: title } : {}) });
  };

  const layoutProps: LayoutProps = {
    rows: rows ?? [],
    fields,
    schema: collection.schema,
    people,
    mayEdit: space.writable,
    onSave: save,
    onOpen,
    onAdd: add,
  };

  return (
    <section className={styles.table} aria-label={collection.title ?? collection.name}>
      <div className={styles.viewbar}>
        <div className={styles.views} role="tablist" aria-label="Views">
          {views.map((v) => (
            <ViewTab
              key={v.record.key}
              view={v}
              selected={v === view}
              onSelect={() => setPickedKey(v.record.key)}
              onRename={(title) =>
                run(() => node.records.update(space.id, v.record.key, { ...bodyOf(v.record), title }))
              }
              onDelete={
                views.length > 1 ? () => run(() => node.records.delete(space.id, v.record.key)) : undefined
              }
            />
          ))}
          {space.writable && <AddView onAdd={addView} />}
        </div>
        <div className={styles.toolbarEnd}>
          <Toolbar
            look={look}
            onLook={saveLook}
            search={searchableFields.length > 0 ? search : null}
            onSearch={setSearch}
            all={all}
            shown={fields}
            groupable={groupable}
            schema={collection.schema}
            people={people}
          />
          {space.writable && (
            <button data-intent="primary" className={styles.newButton} onClick={() => setAdding({})}>
              <Icon name="plus" size={14} />
              New
            </button>
          )}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}

      {look.layout === 'table' && (
        <Grid
          {...layoutProps}
          addColumn={mayAddColumns ? <AddColumn space={space} collection={collection} /> : null}
        />
      )}
      {look.layout === 'board' &&
        (group ? (
          <Board {...layoutProps} group={group} />
        ) : (
          <p className={styles.hint}>
            A board makes a lane for each option of a choice field, like a Status of To do, Doing and Done.
            Add one from the table's + to see this as a board.
          </p>
        ))}
      {look.layout === 'cards' && <Gallery {...layoutProps} />}
      {rows && rows.length === 0 && searchWhere ? (
        <p className={styles.hint}>Nothing matches “{search.trim()}”.</p>
      ) : rows && rows.length === 0 && look.filters?.length ? (
        <p className={styles.hint}>Nothing matches the filters.</p>
      ) : null}
      {more && (
        <button data-intent="ghost" onClick={showMore}>
          Show more
        </button>
      )}

      {adding && (
        <Modal title={`New ${(collection.title ?? 'record').toLowerCase()}`} onClose={() => setAdding(null)}>
          <SchemaForm
            schema={collection.schema}
            initial={adding}
            submitLabel="Add"
            onCancel={() => setAdding(null)}
            onSubmit={async (body) => {
              await node.records.put(space.id, collection.name, body);
              setAdding(null);
            }}
          />
        </Modal>
      )}
    </section>
  );
}

/** Records with the words in any of the fields, ignoring case; undefined when nothing is searched */
function searchFilterOf(search: string, fields: ReadonlyArray<Field>): Filter | undefined {
  const words = search.trim();
  if (!words || fields.length === 0) return undefined;
  return { $or: fields.map((f) => ({ [f.name]: { $contains: words } })) };
}

/** A view's records as its filters, the search and its order pick them, kept current; a page at a time */
function useRows(spaceId: string, collection: string, look: Look, searchWhere: Filter | undefined) {
  const { did } = useAccount();
  const [limit, setLimit] = useState(PAGE);
  const filterWhere = whereOf(look.filters ?? [], did);
  const where =
    filterWhere && searchWhere ? { $and: [filterWhere, searchWhere] } : (filterWhere ?? searchWhere);
  const sort = look.sort ?? NEWEST_FIRST;
  const query = { collection, ...(where ? { where } : {}), sort: { [sort.field]: sort.direction }, limit };
  const page = useLive(spaceId, (node) => node.records.query(spaceId, query), [JSON.stringify(query)]);
  return {
    rows: page?.records ?? null,
    more: page?.cursor != null,
    showMore: () => setLimit((was) => was + PAGE),
  };
}

/** A body with one field set, or taken out when it is emptied */
function withValue(body: Record<string, unknown>, name: string, value: unknown): Record<string, unknown> {
  const next = { ...body };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}

/** A view's tab. Pressed again once open, it offers to rename the view or delete it */
function ViewTab({
  view,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  view: SheetView;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<unknown>;
  /** None for a table's last view, which the table can't be without */
  onDelete: (() => Promise<unknown>) | undefined;
}) {
  const { open, setOpen, close, root } = usePopover();
  const [renaming, setRenaming] = useState(false);

  if (renaming)
    return (
      <input
        className={styles.rename}
        defaultValue={view.title}
        autoFocus
        aria-label="View name"
        maxLength={100}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setRenaming(false);
        }}
        onBlur={(e) => {
          setRenaming(false);
          const title = e.currentTarget.value.trim();
          if (title && title !== view.title) void onRename(title);
        }}
      />
    );
  return (
    <div ref={root} className={styles.popoverAnchor}>
      <button
        role="tab"
        className={styles.viewTab}
        aria-selected={selected}
        onClick={() => (selected ? setOpen((was) => !was) : onSelect())}
      >
        <Icon name={LAYOUT_ICONS[view.look.layout]} size={14} />
        {view.title}
      </button>
      {open && (
        <Panel anchor={root} align="start" className={styles.choices}>
          <button
            onClick={() => {
              close();
              setRenaming(true);
            }}
          >
            <Icon name="pencil" size={14} />
            Rename
          </button>
          {onDelete && (
            <button
              onClick={() => {
                close();
                void onDelete();
              }}
            >
              <Icon name="trash" size={14} />
              Delete view
            </button>
          )}
        </Panel>
      )}
    </div>
  );
}

/** "+" after the views: a new one, laid out as picked, starting from how the open one looks */
function AddView({ onAdd }: { onAdd: (layout: Layout) => Promise<unknown> }) {
  const { open, setOpen, close, root } = usePopover();
  return (
    <div ref={root} className={styles.popoverAnchor}>
      <button
        className={styles.tool}
        onClick={() => setOpen((was) => !was)}
        aria-label="Add a view"
        aria-expanded={open}
      >
        <Icon name="plus" size={14} />
      </button>
      {open && (
        <Panel anchor={root} align="start" className={styles.choices}>
          {LAYOUTS.map((layout) => (
            <button
              key={layout}
              onClick={() => {
                close();
                void onAdd(layout);
              }}
            >
              <Icon name={LAYOUT_ICONS[layout]} size={14} />
              {LAYOUT_LABELS[layout]}
            </button>
          ))}
        </Panel>
      )}
    </div>
  );
}
