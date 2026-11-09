import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { useCan, useLive, useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Icon } from '@minca/app-shared/Icon';
import { offLimits } from '@minca/app-shared/screens';
import { collectionLabel, bodyOf } from '../../derive/schema-ui';
import { LAYOUT_LABELS, LAYOUTS, type Layout, type Look } from '../../derive/look';
import { useKeptLook, useRemembered } from '../../kept';
import { CollectionView } from '../CollectionView';
import { CollectionsOverview } from '../CollectionsOverview';
import { CollectionEditor } from '../CollectionDesigner';
import { usePopover } from '../usePopover';
import { newViewBody, sheetView, viewsOf, type SheetView } from './sheet-views';
import styles from './Sheets.module.css';

/** The view that defines a new collection, as Sheets' views name it */
const NEW_COLLECTION = '__new__';

/** The collections Sheets shows: every defined one but the space's own and its views, the space's before the standard ones */
function collectionsShown(collections: ReadonlyArray<NodeCollection>): ReadonlyArray<NodeCollection> {
  return collections
    .filter((c) => c.version !== null && !offLimits(c.name) && c.name !== sheetView.name)
    .sort((a, b) => Number(a.name.startsWith('std.')) - Number(b.name.startsWith('std.')));
}

/**
 * Sheets: the collections down the side, the open one beside them in one of
 * its views. `view` is the open collection's name, as the app's bar goes back
 * out of it.
 */
export function Sheets({
  space,
  collections,
  onOpen,
  view,
  onGo,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
  view: string | null;
  onGo?: ((view: string | null, title: string | null) => void) | undefined;
}) {
  const shown = collectionsShown(collections);
  const open = shown.find((c) => c.name === view) ?? null;
  const goTo = (collection: NodeCollection) => onGo?.(collection.name, collectionLabel(collection));
  const goToName = (name: string | null) => {
    const collection = name ? collections.find((c) => c.name === name) : null;
    onGo?.(name, collection ? collectionLabel(collection) : null);
  };

  return (
    <div className={styles.layout}>
      <nav aria-label="Collections" className={`stack ${styles.side}`} data-gap="tight">
        {shown.map((c) => (
          <button
            key={c.name}
            data-intent="ghost"
            className="row"
            data-spread
            onClick={() => goTo(c)}
            aria-current={open?.name === c.name ? 'page' : undefined}
            title={c.name}
          >
            <span>{collectionLabel(c)}</span>
            <small>{c.records}</small>
          </button>
        ))}
        {space.writable && (
          <button
            data-intent="ghost"
            className="row"
            onClick={() => onGo?.(NEW_COLLECTION, 'New collection')}
            aria-current={view === NEW_COLLECTION ? 'page' : undefined}
          >
            <Icon name="plus" size={14} />
            New collection
          </button>
        )}
      </nav>

      <div className="stack">
        {view === NEW_COLLECTION ? (
          <section className="stack">
            <h2>New collection</h2>
            <CollectionEditor space={space} collection={null} onDone={goToName} />
          </section>
        ) : open ? (
          <CollectionInViews
            key={open.name}
            space={space}
            collection={open}
            collections={collections}
            onOpen={onOpen}
          />
        ) : (
          <>
            <CollectionsOverview collections={shown} namespace={null} onOpen={(name) => goToName(name)} />
            {space.writable && (
              <button data-intent="primary" onClick={() => onGo?.(NEW_COLLECTION, 'New collection')}>
                New collection
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One collection, in the view picked from its tabs: Everything, as this device
 * last looked at it, or a saved view everyone in the space sees.
 */
function CollectionInViews({
  space,
  collection,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  collection: NodeCollection;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const { name } = collection;
  const records = useLive(space.id, (n) => n.records.list(space.id, { collection: sheetView.name }), []);
  const views = viewsOf(records ?? [], name);
  const [pickedKey, setPickedKey] = useRemembered(`minca.sheet:${space.id}:${name}`);
  const picked = views.find((v) => v.record.key === pickedKey) ?? null;
  const [keptLook, setKeptLook] = useKeptLook(space.id, name);
  const { run, error } = useAction();

  const look = picked?.look ?? keptLook;
  const saveLook = (next: Look) => {
    if (!picked) return setKeptLook(next);
    void run(() => node.records.update(space.id, picked.record.key, { ...bodyOf(picked.record), ...next }));
  };
  const addView = (layout: Layout) =>
    run(async () => {
      const added = await node.records.put(
        space.id,
        sheetView.name,
        newViewBody(name, LAYOUT_LABELS[layout], { ...look, layout }, views),
      );
      setPickedKey(added.key);
    });

  return (
    <div className="stack">
      <div className="row">
        <div role="tablist" aria-label="Views">
          <button role="tab" aria-selected={picked === null} onClick={() => setPickedKey('')}>
            Everything
          </button>
          {views.map((v) => (
            <button
              key={v.record.key}
              role="tab"
              aria-selected={v === picked}
              onClick={() => setPickedKey(v.record.key)}
            >
              {v.title}
            </button>
          ))}
        </div>
        {picked && (
          <ViewMenu
            key={picked.record.key}
            space={space}
            view={picked}
            onRename={(title) =>
              run(() => node.records.update(space.id, picked.record.key, { ...bodyOf(picked.record), title }))
            }
            onDelete={() => run(() => node.records.delete(space.id, picked.record.key))}
          />
        )}
        {space.writable && <AddView onAdd={addView} />}
      </div>
      {error && <p role="alert">{error}</p>}
      <CollectionView
        space={space}
        name={name}
        collection={collection}
        collections={collections}
        look={look}
        onLook={saveLook}
        onOpen={onOpen}
      />
    </div>
  );
}

/** Renaming or deleting the view that is open, for whoever may change it */
function ViewMenu({
  space,
  view,
  onRename,
  onDelete,
}: {
  space: SpaceSummary;
  view: SheetView;
  onRename: (title: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const { open, setOpen, close, root } = usePopover();
  const [renaming, setRenaming] = useState(false);
  const mayChange = useCan(space.id, 'edit', view.record.key);
  if (!mayChange) return null;

  if (renaming) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const title = new FormData(e.currentTarget).get('title');
          setRenaming(false);
          if (typeof title === 'string' && title.trim() && title.trim() !== view.title)
            void onRename(title.trim());
        }}
      >
        <input
          name="title"
          defaultValue={view.title}
          autoFocus
          aria-label="View name"
          maxLength={100}
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
        />
      </form>
    );
  }
  return (
    <span ref={root} className="anchor down">
      <button
        data-intent="ghost"
        data-icon
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Change view ${view.title}`}
      >
        <Icon name="settings" size={16} />
      </button>
      {open && (
        <menu role="menu">
          <li>
            <button
              role="menuitem"
              onClick={() => {
                close();
                setRenaming(true);
              }}
            >
              <Icon name="pencil" size={14} />
              Rename view
            </button>
          </li>
          <li>
            <button
              role="menuitem"
              onClick={() => {
                close();
                void onDelete();
              }}
            >
              <Icon name="trash" size={14} />
              Delete view
            </button>
          </li>
        </menu>
      )}
    </span>
  );
}

/** "+ View": a new saved view, laid out as picked, starting from how the collection looks now */
function AddView({ onAdd }: { onAdd: (layout: Layout) => Promise<unknown> }) {
  const { open, setOpen, close, root } = usePopover();
  return (
    <span ref={root} className="anchor down">
      <button
        data-intent="ghost"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Icon name="plus" size={14} />
        View
      </button>
      {open && (
        <menu role="menu" aria-label="New view">
          {LAYOUTS.map((layout) => (
            <li key={layout}>
              <button
                role="menuitem"
                onClick={() => {
                  close();
                  void onAdd(layout);
                }}
              >
                {LAYOUT_LABELS[layout]}
              </button>
            </li>
          ))}
        </menu>
      )}
    </span>
  );
}
