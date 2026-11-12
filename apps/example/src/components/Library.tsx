import { useState } from 'react';
import { useNode } from '@minca/react';
import type { NodeCollection, SpaceSummary } from '@minca/core';
// `useSchemas` defines collections in a space; it is not a React hook, whatever its name says.
import { standardAnnotations, useSchemas as addSchemas } from '@minca/std';

const WHAT_IT_ADDS: Record<string, string> = {
  'std.reaction': 'Emoji reactions on anything — one of each per person.',
  'std.comment': 'A comment thread on every record.',
  'std.tag': 'Labels on records, shown as #tags.',
  'std.file': 'Files on any record: pictures, videos and documents, shown with it.',
};

/** The standard schemas this space has not added yet, each a click away */
export function Library({
  space,
  collections,
  title,
  onAdded,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  title: string;
  onAdded?: (name: string) => void;
}) {
  const node = useNode();
  const [busy, setBusy] = useState<string | null>(null);
  const defined = new Set(collections.filter((c) => c.version !== null).map((c) => c.name));
  const missing = standardAnnotations.filter((s) => !defined.has(s.name));
  if (!space.writable || missing.length === 0) return null;

  return (
    <section aria-label="Standard schemas">
      <div>
        <h3>{title}</h3>
        <small>Shared shapes, so other apps understand them too.</small>
      </div>
      <div className="grid">
        {missing.map((schema) => (
          <article key={schema.name}>
            <div className="row" data-spread>
              <strong>{schema.title}</strong>
              <button
                data-intent="ghost"
                onClick={() => {
                  setBusy(schema.name);
                  void addSchemas(node, space.id, [schema])
                    .then(() => onAdded?.(schema.name))
                    .finally(() => setBusy(null));
                }}
                disabled={busy !== null}
                aria-label={`Add ${schema.title}`}
              >
                {busy === schema.name ? 'Adding…' : 'Add'}
              </button>
            </div>
            <small>{WHAT_IT_ADDS[schema.name] ?? schema.description}</small>
            <small>
              <code>{schema.name}</code>
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
