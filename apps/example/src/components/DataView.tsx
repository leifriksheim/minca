import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { Fragment, useState } from 'react';
import { collectionLabel } from '../derive/schema-ui';
import { namespaceOf } from '../derive/filters';
import { CollectionView } from './CollectionView';
import { CollectionsOverview, namespaceLabel } from './CollectionsOverview';
import { Library } from './Library';
import { CollectionEditor } from './CollectionDesigner';
import styles from './DataView.module.css';
import { Info } from '@minca/app-shared/Info';

/** Where the Data view is: which collection, and which record is open beside it */
export interface Place {
  readonly collection: string | null;
  readonly key: string | null;
}

/** Defining a new collection, in the main area */
export const NEW = '__new__';
/** Every collection at once, in the main area */
const ALL = '__all__';

/**
 * Every record in a space, collection by collection: the collections down
 * the side, the chosen one beside them. Drawn from what the space says about
 * itself — nothing here knows what any of the records are.
 */
export function DataView({
  space,
  collections,
  place,
  onPlace,
  onOpen,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  place: Place;
  onPlace: (place: Place) => void;
  onOpen: (record: NodeRecord) => void;
}) {
  // Which namespace it shows; null for all of them.
  const [namespace, setNamespace] = useState<string | null>(null);

  // The space's own collections come before the standard ones.
  const ordered = [...collections].sort(
    (a, b) => Number(a.name.startsWith('std.')) - Number(b.name.startsWith('std.')),
  );
  const namespaces = [...new Set(ordered.map((c) => namespaceOf(c.name)))];
  const shown = namespace === null ? ordered : ordered.filter((c) => namespaceOf(c.name) === namespace);
  // Collections under a heading for their namespace, when there is more than one to tell apart.
  const groups = (namespace === null ? namespaces : [namespace])
    .map((ns) => ({ ns, members: shown.filter((c) => namespaceOf(c.name) === ns) }))
    .filter((g) => g.members.length > 0);
  // Land on every collection at once rather than an empty page.
  const selected =
    place.collection === NEW
      ? NEW
      : ordered.some((c) => c.name === place.collection)
        ? place.collection
        : ordered.length
          ? ALL
          : null;
  const current = collections.find((c) => c.name === selected) ?? null;

  return (
    <div className={styles.layout}>
      <div className={`stack ${styles.side}`} data-gap="loose">
        {namespaces.length > 1 && (
          <label>
            <span className={styles.heading}>Namespace</span>
            <select
              value={namespace ?? ALL}
              onChange={(e) => setNamespace(e.target.value === ALL ? null : e.target.value)}
              aria-label="Namespace"
            >
              <option value={ALL}>All namespaces</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {namespaceLabel(ns)}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav aria-label="Collections" className={`stack ${styles.nav}`} data-gap="tight">
          <small className={styles.heading}>In this space</small>
          {ordered.length > 0 && (
            <button
              data-intent="ghost"
              className="row"
              data-spread
              onClick={() => onPlace({ collection: ALL, key: null })}
              aria-current={selected === ALL ? 'page' : undefined}
            >
              <span>All collections</span>
              <small>{shown.length}</small>
            </button>
          )}
          {groups.map((g) => (
            <Fragment key={g.ns}>
              {groups.length > 1 && <small className={styles.heading}>{namespaceLabel(g.ns)}</small>}
              {g.members.map((c) => (
                <button
                  key={c.name}
                  data-intent="ghost"
                  className="row"
                  data-spread
                  onClick={() => onPlace({ collection: c.name, key: null })}
                  aria-current={selected === c.name ? 'page' : undefined}
                  title={c.name}
                >
                  <span>{collectionLabel(c)}</span>
                  <small>{c.records}</small>
                </button>
              ))}
            </Fragment>
          ))}
          {ordered.length === 0 && <small>Nothing yet</small>}
          {space.writable && (
            <button
              data-intent="ghost"
              className="row"
              onClick={() => onPlace({ collection: NEW, key: null })}
              aria-current={selected === NEW ? 'page' : undefined}
            >
              + New collection
            </button>
          )}
        </nav>
      </div>

      <div className="stack">
        {selected === NEW ? (
          <section>
            <div className="stack" data-gap="tight">
              <h2>
                New collection
                <Info label="About collections">
                  Give it a name and some fields. Everything else — forms, lists, boards — is worked out from
                  this.
                </Info>
              </h2>
            </div>
            <CollectionEditor
              space={space}
              collection={null}
              onDone={(name) => onPlace({ collection: name, key: null })}
            />
            <Library
              space={space}
              collections={collections}
              title="Or add one from the library"
              onAdded={(name) => onPlace({ collection: name, key: null })}
            />
          </section>
        ) : selected === ALL ? (
          <CollectionsOverview
            collections={shown}
            namespace={namespace}
            onOpen={(name) => onPlace({ collection: name, key: null })}
          />
        ) : selected ? (
          <CollectionView
            key={selected}
            space={space}
            name={selected}
            collection={current}
            collections={collections}
            onOpen={onOpen}
          />
        ) : (
          <div className="empty">
            <strong>This space is empty</strong>
            <p>
              Define a collection — or ask an agent: this page offers the space's operations as WebMCP tools.
            </p>
            {space.writable && (
              <button data-intent="primary" onClick={() => onPlace({ collection: NEW, key: null })}>
                New collection
              </button>
            )}
          </div>
        )}
        {!selected && (
          <Library
            space={space}
            collections={collections}
            title="Start with a standard schema"
            onAdded={(name) => onPlace({ collection: name, key: null })}
          />
        )}
      </div>
    </div>
  );
}
