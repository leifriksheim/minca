import { useMemo, useState } from 'react';
import type { NodeCollection, NodeRecord } from '@minca/core';
import { useLive } from '@minca/react';
import { collectionLabel, recordLabel } from '../derive/schema-ui';
import { styles, palette } from '../styles';

/**
 * Records in a space to choose one of, newest first, found by what they say
 * or what kind they are: what linking a record and sharing one into an app
 * both start from.
 */
export function RecordFinder({
  spaceId,
  collections,
  accepts,
  onPick,
  disabled = false,
  initialText = '',
  placeholder = 'Find anything',
}: {
  spaceId: string;
  collections: ReadonlyArray<NodeCollection>;
  /** Which records may be chosen */
  accepts: (record: NodeRecord) => boolean;
  onPick: (record: NodeRecord) => void;
  disabled?: boolean;
  initialText?: string;
  placeholder?: string;
}) {
  const [search, setSearch] = useState(initialText);
  const everything = useLive(spaceId, (n) => n.records.list(spaceId, { newestFirst: true }), []) ?? [];
  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const labelOf = (r: NodeRecord) => recordLabel(r, schemaOf(r.collection));
  const kindOf = (name: string) => {
    const c = collections.find((x) => x.name === name);
    return c ? collectionLabel(c) : name;
  };

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return everything
      .filter((r) => r.body !== null && accepts(r))
      .filter(
        (r) => !q || labelOf(r).toLowerCase().includes(q) || kindOf(r.collection).toLowerCase().includes(q),
      )
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labels follow the collections
  }, [everything, search, accepts, collections]);

  return (
    <>
      <input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || disabled || !candidates[0]) return;
          e.preventDefault();
          onPick(candidates[0]);
        }}
        placeholder={placeholder}
        aria-label="Find a record"
        style={styles.input}
      />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {candidates.map((r) => (
          <button
            key={r.key}
            type="button"
            disabled={disabled}
            onClick={() => onPick(r)}
            data-row
            style={pickRow}
          >
            <span
              style={{
                color: palette.ink.faint,
                fontSize: 12,
                width: 90,
                flexShrink: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {kindOf(r.collection)}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {labelOf(r)}
            </span>
          </button>
        ))}
        {candidates.length === 0 && (
          <span style={{ fontSize: 13, color: palette.ink.faint, padding: 6 }}>Nothing found.</span>
        )}
      </div>
    </>
  );
}

const pickRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 6px',
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  textAlign: 'left' as const,
  fontSize: 14,
  width: '100%',
};
