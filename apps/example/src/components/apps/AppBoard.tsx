import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { useLive, useNode, useProfiles } from '@minca/react';
import { SchemaForm } from '../SchemaForm';
import { Value } from '../Value';
import {
  choicesFrom,
  choicesOf,
  collectionLabel,
  bodyOf,
  fieldsOf,
  metaFields,
  recordLabel,
  titleField,
  type Field,
} from '../../derive/schema-ui';
import { nameOf, peopleFrom, writerOf, type People } from '../../derive/people';
import { ago } from '@minca/ui/time';
import { Loader } from '@minca/app-shared/Loader';

/**
 * An added app drawn from its definitions alone: unlinked records are the list, what links to them
 * is drawn inside, as pick buttons (`x-choicesFrom`), a one-per-person toggle, or a small form.
 */
export function AppBoard({
  space,
  names,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  names: ReadonlyArray<string>;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}) {
  const people = peopleFrom(useProfiles(space.id));
  const held = names
    .map((name) => collections.find((c) => c.name === name))
    .filter((c): c is NodeCollection => !!c && c.version !== null);
  const records = useLive(
    space.id,
    (node) => Promise.all(held.map((c) => node.records.list(space.id, { collection: c.name }))),
    [space.id, held.map((c) => c.name).join('|')],
  );

  /** Collections of this app that point at `parent`, with the link role they use */
  const childrenOf = (parent: NodeCollection) =>
    held.flatMap((child) =>
      Object.entries(child.links)
        .filter(([, link]) => link.to !== '*' && link.to.includes(parent.name))
        .map(([rel]) => ({ child, rel })),
    );
  const pointsIntoApp = (c: NodeCollection) =>
    Object.values(c.links).some(
      (link) => link.to !== '*' && link.to.some((to) => names.includes(to) && to !== c.name),
    );
  const main = held.filter((c) => !pointsIntoApp(c));

  if (!records)
    return (
      <p className="empty">
        <Loader label="Opening" showLabel />
      </p>
    );
  const byName = new Map(held.map((c, i) => [c.name, records[i] ?? []]));

  return (
    <div className="stack" data-gap="loose">
      {main.map((parent) => (
        <section key={parent.name} aria-label={collectionLabel(parent)}>
          <AddForm space={space} collection={parent} label={`Add ${noun(parent)}`} />
          {(byName.get(parent.name) ?? []).length === 0 && (
            <div className="empty">
              <p>No {noun(parent)} yet.</p>
            </div>
          )}
          {(byName.get(parent.name) ?? []).map((record) => (
            <article key={record.key}>
              <header>
                <button type="button" data-intent="inline" onClick={() => onOpen(record)}>
                  {recordLabel(record, parent.schema)}
                </button>
                <small>
                  {writerOf(record, people)} · {ago(record.createdAt)}
                </small>
              </header>
              <Meta collection={parent} record={record} />
              {childrenOf(parent).map(({ child, rel }) => (
                <Children
                  key={`${child.name}:${rel}`}
                  space={space}
                  child={child}
                  rel={rel}
                  parent={record}
                  records={(byName.get(child.name) ?? []).filter((r) =>
                    r.links.some((l) => l.rel === rel && l.to === record.key),
                  )}
                  people={people}
                  onOpen={onOpen}
                />
              ))}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

const noun = (c: NodeCollection) => collectionLabel(c).toLowerCase();

/** What a record says in its title field, when it says anything — "Can take a bike", not a made-up label */
function said(record: NodeRecord, collection: NodeCollection): string | null {
  const title = titleField(collection.schema);
  const value = title ? bodyOf(record)[title] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The short fields beside a title */
function Meta({ collection, record }: { collection: NodeCollection; record: NodeRecord }) {
  const body = bodyOf(record);
  const fields = metaFields(collection.schema).filter(
    (f) => body[f.name] !== undefined && body[f.name] !== '',
  );
  if (fields.length === 0) return null;
  return (
    <small className="row">
      {fields.map((f) => (
        <span key={f.name}>
          {f.label}{' '}
          <strong>
            <Value field={f} value={body[f.name]} compact />
          </strong>
        </span>
      ))}
    </small>
  );
}

/** What points at one record, drawn inside it — and the way to add one */
function Children({
  space,
  child,
  rel,
  parent,
  records,
  people,
  onOpen,
}: {
  space: SpaceSummary;
  child: NodeCollection;
  rel: string;
  parent: NodeRecord;
  records: ReadonlyArray<NodeRecord>;
  people: People;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const { run, busy, error } = useAction();
  const fields = fieldsOf(child.schema);
  const mine = records.find((r) => r.createdBy === node.did);
  const links = [{ rel, to: parent.key }];
  const onePerMe = !!child.rules.onePer?.includes('@author') && !!child.rules.onePer?.includes(`link:${rel}`);

  // A field that picks from the parent: buttons with counts.
  const picker: Field | undefined = fields.find((f) => choicesFrom(f.schema)?.rel === rel);
  const choices = picker ? choicesOf(picker, { [rel]: parent }) : null;
  if (picker && choices) {
    const chosen = bodyOf(mine)[picker.name];
    const pick = (value: unknown) =>
      run(() =>
        mine && !onePerMe
          ? node.records.update(space.id, mine.key, { ...bodyOf(mine), [picker.name]: value })
          : node.records.put(space.id, child.name, { [picker.name]: value }, { links }),
      );
    return (
      <div className="stack">
        <div className="row" data-gap="tight">
          {choices.map((choice) => {
            const count = records.filter((r) => bodyOf(r)[picker.name] === choice.value).length;
            return (
              <button
                type="button"
                key={String(choice.value)}
                onClick={() => void pick(choice.value)}
                disabled={busy}
                aria-pressed={chosen === choice.value}
              >
                {choice.label} {count}
              </button>
            );
          })}
        </div>
        {mine && (
          <small>
            You picked — pick again to change{' '}
            <button
              type="button"
              data-intent="inline"
              onClick={() => void run(() => node.records.delete(space.id, mine.key))}
            >
              or take it back
            </button>
          </small>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  const nothingToFill = fields.every((f) => !f.required);
  const label = noun(child);
  return (
    <div className="stack">
      <hr />
      <div className="row" data-spread>
        <small>
          {records.length} {records.length === 1 ? label : `${label}s`}
        </small>
        {onePerMe && nothingToFill ? (
          mine ? (
            <button
              type="button"
              data-intent="ghost"
              onClick={() => void run(() => node.records.delete(space.id, mine.key))}
              disabled={busy}
            >
              Remove your {label}
            </button>
          ) : (
            <button
              type="button"
              data-intent="primary"
              onClick={() => void run(() => node.records.put(space.id, child.name, {}, { links }))}
              disabled={busy}
            >
              Add your {label}
            </button>
          )
        ) : (
          <AddForm space={space} collection={child} label={`Add ${label}`} links={links} />
        )}
      </div>
      {records.length > 0 && (
        <div className="row">
          {records.map((r) => (
            <button type="button" data-intent="inline" key={r.key} onClick={() => onOpen(r)}>
              {said(r, child) ? `${nameOf(r.createdBy, people)}: ${said(r, child)}` : writerOf(r, people)}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** "Add a trip…", opening a form built from the definition */
function AddForm({
  space,
  collection,
  label,
  links,
}: {
  space: SpaceSummary;
  collection: NodeCollection;
  label: string;
  links?: ReadonlyArray<{ rel: string; to: string }>;
}) {
  const node = useNode();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" data-intent="ghost" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <article>
      <SchemaForm
        schema={collection.schema}
        submitLabel={label}
        onSubmit={async (body) => {
          await node.records.put(space.id, collection.name, body, links ? { links } : {});
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </article>
  );
}
