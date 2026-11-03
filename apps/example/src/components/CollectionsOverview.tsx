import type { NodeCollection } from '@minca/core';
import { collectionLabel, fieldsOf } from '../derive/schema-ui';
import { namespaceOf } from '../derive/filters';
import table from './table.module.css';

/** How a namespace reads in a list: its name, or a word for having none */
export const namespaceLabel = (namespace: string) => namespace || 'No namespace';

/** Every collection in the space, or in one namespace, with how many records each holds and their shape */
export function CollectionsOverview({
  collections,
  namespace,
  onOpen,
}: {
  collections: ReadonlyArray<NodeCollection>;
  namespace: string | null;
  onOpen: (name: string) => void;
}) {
  const total = collections.reduce((sum, c) => sum + c.records, 0);
  return (
    <section aria-label="All collections">
      <div className="stack" data-gap="tight">
        <h2>{namespace === null ? 'All collections' : namespaceLabel(namespace)}</h2>
        <small>
          {collections.length} collection{collections.length === 1 ? '' : 's'}, {total} record
          {total === 1 ? '' : 's'}
        </small>
      </div>
      {collections.length === 0 ? (
        <p className="empty">No collections here.</p>
      ) : (
        <div className={table.table}>
          <table>
            <thead>
              <tr>
                <th>Collection</th>
                <th>Namespace</th>
                <th>Fields</th>
                <th>Records</th>
              </tr>
            </thead>
            <tbody className={table.opens}>
              {collections.map((c) => (
                <tr
                  key={c.name}
                  tabIndex={0}
                  onClick={() => onOpen(c.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpen(c.name);
                  }}
                  aria-label={`Open ${collectionLabel(c)}`}
                >
                  <td>
                    <div className="stack" data-gap="tight">
                      <strong>{collectionLabel(c)}</strong>
                      <small>
                        <code>{c.name}</code>
                      </small>
                      {c.description && <small>{c.description}</small>}
                    </div>
                  </td>
                  <td>{namespaceLabel(namespaceOf(c.name))}</td>
                  <td>{c.schema ? fieldsOf(c.schema).length : 'Not defined'}</td>
                  <td>{c.records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
