import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { collectionLabel, humanize } from '../derive/schema-ui';
import { useAction } from '@minca/app-shared/action';
import { RecordFinder } from './RecordFinder';

/**
 * Links this record to another, in one of the ways its collection allows —
 * and only to the collections each way may point at. What those ways are
 * is part of the collection's definition, changed there, not here.
 */
export function LinkPicker({
  space,
  record,
  collection,
  collections,
  initialRel,
  onDone,
}: {
  space: SpaceSummary;
  record: NodeRecord;
  collection: NodeCollection;
  collections: ReadonlyArray<NodeCollection>;
  /** The kind of link to start on */
  initialRel?: string;
  onDone: () => void;
}) {
  const node = useNode();
  const kinds = Object.entries(collection.links);
  const [rel, setRel] = useState<string | null>(initialRel ?? (kinds.length === 1 ? kinds[0]![0] : null));
  const { run, busy, error } = useAction();

  const kindOf = (name: string) => {
    const c = collections.find((x) => x.name === name);
    return c ? collectionLabel(c) : name;
  };

  const declared = rel ? collection.links[rel] : undefined;
  const one = declared?.cardinality === 'one';
  const current = rel ? record.links.filter((l) => l.rel === rel) : [];
  const link = async (target: NodeRecord) => {
    if (!rel) return;
    // A kind of link there can be only one of is replaced, not added to.
    const kept = one ? record.links.filter((l) => l.rel !== rel) : record.links;
    if (
      await run(() =>
        node.records.update(space.id, record.key, record.body, { links: [...kept, { rel, to: target.key }] }),
      )
    )
      onDone();
  };

  const allowed = declared ? (declared.to === '*' ? 'anything' : declared.to.map(kindOf).join(' or ')) : '';

  return (
    <article aria-label="Link to another record">
      <h3>{rel ? `${humanize(rel)}…` : 'Link to…'}</h3>
      {!initialRel && kinds.length > 1 && (
        <div className="row" data-gap="tight">
          {kinds.map(([r, d]) => (
            <button
              key={r}
              type="button"
              onClick={() => setRel(r)}
              title={d.description}
              aria-pressed={rel === r}
            >
              {humanize(r).toLowerCase()}
            </button>
          ))}
        </div>
      )}
      {declared && (
        <>
          <small>
            <strong>{humanize(rel!).toLowerCase()}</strong>
            {declared.description && ` — ${declared.description}`}. Can point at {allowed}
            {one && current.length > 0 ? '; picking one replaces the one it has.' : '.'}
          </small>
          <RecordFinder
            spaceId={space.id}
            collections={collections}
            accepts={(r) =>
              r.key !== record.key &&
              !current.some((l) => l.to === r.key) &&
              (declared.to === '*' || declared.to.includes(r.collection))
            }
            onPick={(r) => void link(r)}
            disabled={busy}
            placeholder={`Find ${allowed === 'anything' ? 'anything' : allowed}`}
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <button type="button" data-intent="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </article>
  );
}
