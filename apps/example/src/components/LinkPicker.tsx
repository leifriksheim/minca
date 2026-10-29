import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { collectionLabel, humanize } from '../derive/schema-ui';
import { styles, palette, stack } from '../styles';
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
    <section
      aria-label="Link to another record"
      style={{
        ...stack(10),
        padding: 14,
        border: `1px solid ${palette.surface.line}`,
        borderRadius: palette.radius.md,
      }}
    >
      <h3 style={styles.sectionTitle}>{rel ? `${humanize(rel)}…` : 'Link to…'}</h3>
      {!initialRel && kinds.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {kinds.map(([r, d]) => (
            <button
              key={r}
              type="button"
              onClick={() => setRel(r)}
              title={d.description}
              aria-pressed={rel === r}
              data-variant="quiet"
              style={{
                ...styles.smallButton,
                height: 28,
                ...(rel === r ? { borderColor: palette.ink.strong, color: palette.ink.strong } : {}),
              }}
            >
              {humanize(r).toLowerCase()}
            </button>
          ))}
        </div>
      )}
      {declared && (
        <>
          <p style={{ ...styles.quiet, lineHeight: 1.5 }}>
            <strong style={{ color: palette.ink.strong }}>{humanize(rel!).toLowerCase()}</strong>
            {declared.description && ` — ${declared.description}`}. Can point at {allowed}
            {one && current.length > 0 ? '; picking one replaces the one it has.' : '.'}
          </p>
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
      {error && <p style={styles.error}>{error}</p>}
      <button
        type="button"
        onClick={onDone}
        data-variant="ghost"
        style={{ ...styles.linkButton, alignSelf: 'flex-start' }}
      >
        Cancel
      </button>
    </section>
  );
}
