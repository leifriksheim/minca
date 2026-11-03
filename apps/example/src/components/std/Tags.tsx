import { useState } from 'react';
import { useCan, useNode } from '@minca/react';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import { tag } from '@minca/core/schemas';
import { bodyOf } from '../../derive/schema-ui';

/** A tag's label, if the record is one */
export function tagLabel(r: NodeRecord): string {
  const label = bodyOf(r).label;
  return typeof label === 'string' ? label : '';
}

/**
 * `std.tag` on a record: each tag is a small record of its own, pointing at
 * the thing it labels — so removing one is deleting it, and anyone's app that
 * uses `std.tag` sees the same labels.
 */
export function Tags({
  space,
  target,
  tags,
}: {
  space: SpaceSummary;
  target: string;
  tags: ReadonlyArray<NodeRecord>;
}) {
  const node = useNode();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const labels = new Set(tags.map(tagLabel));

  const add = () => {
    const label = draft.trim().toLowerCase();
    setDraft('');
    setAdding(false);
    if (!label || labels.has(label)) return;
    void node.records.put(space.id, tag.name, { label }, { links: [{ rel: 'about', to: target }] });
  };

  return (
    <div className="row" data-gap="tight" aria-label="Tags">
      {tags.map((t) => (
        <TagChip key={t.key} space={space} tag={t} />
      ))}
      {space.writable &&
        (adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={add}
              placeholder="tag"
              aria-label="New tag"
            />
          </form>
        ) : (
          <button data-intent="ghost" onClick={() => setAdding(true)}>
            + Tag
          </button>
        ))}
    </div>
  );
}

/** One tag. Yours to remove — or anyone's, if your role here may moderate tags: the rules say, not this. */
function TagChip({ space, tag: t }: { space: SpaceSummary; tag: NodeRecord }) {
  const node = useNode();
  const mayRemove = useCan(space.id, 'delete', t.key);
  return (
    <span className="tag">
      #{tagLabel(t)}
      {mayRemove && (
        <button
          onClick={() => void node.records.delete(space.id, t.key)}
          aria-label={`Remove tag ${tagLabel(t)}`}
          data-intent="inline"
        >
          ✕
        </button>
      )}
    </span>
  );
}
