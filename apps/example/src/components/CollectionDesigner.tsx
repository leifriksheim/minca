import { useRef, useState, type KeyboardEvent } from 'react';
import { useMayDefine } from '@minca/app-shared/may';
import type { DefineCollection, JsonSchema, NodeCollection, SpaceSummary } from '@minca/core';
import { useAccount, useCollections, useNode, useProfiles } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { nameOf, peopleFrom } from '../derive/people';
import { collectionLabel, humanize, isObject } from '../derive/schema-ui';
import {
  FIELD_TYPES,
  FIELD_TYPE_INFO,
  SUGGESTED_LINKS,
  fieldNameFrom,
  fieldSchema,
  fieldTypeOf,
  isFieldType,
  relFrom,
  type FieldTypeName,
} from '../derive/field-types';
import { SchemaForm } from './SchemaForm';
import styles from './CollectionDesigner.module.css';
import { confirmThen } from '../confirm';
import { Info } from '@minca/app-shared/Info';
import { Icon } from '@minca/app-shared/Icon';
import { moved, useDragOrder } from '../drag-order';

type LinkDeclaration = NonNullable<DefineCollection['links']>[string];

/** A field as the designer edits it */
interface FieldDraft {
  readonly id: number;
  /** The name it is stored under, for a field that already exists: kept, so its records keep their values */
  readonly was?: string;
  label: string;
  /** Null for a field of a shape the designer doesn't offer — kept exactly as it is */
  type: FieldTypeName | null;
  options: ReadonlyArray<string>;
  required: boolean;
  /** The field's schema as it stands */
  readonly original?: JsonSchema;
}

interface LinkDraft {
  readonly id: number;
  readonly was?: string;
  label: string;
  description: string;
  /** Empty means anything */
  to: ReadonlyArray<string>;
  many: boolean;
}

/** Where a new collection starts: a few fields that thing usually has */
const TEMPLATES: ReadonlyArray<{
  title: string;
  /** What one of them is called, for the name when none is typed yet */
  thing?: string;
  fields: ReadonlyArray<{ label: string; type: FieldTypeName; required?: boolean; options?: string[] }>;
}> = [
  { title: 'Blank', fields: [{ label: 'Title', type: 'text', required: true }] },
  {
    title: 'To-do',
    thing: 'Task',
    fields: [
      { label: 'Title', type: 'text', required: true },
      { label: 'Done', type: 'yes/no' },
      { label: 'Due', type: 'date' },
      { label: 'Assigned to', type: 'people' },
    ],
  },
  {
    title: 'Sign-up sheet',
    thing: 'Sign-up',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Slot', type: 'choice', options: ['Morning', 'Afternoon', 'Evening'] },
      { label: 'Note', type: 'long text' },
    ],
  },
  {
    title: 'Reading list',
    thing: 'Book',
    fields: [
      { label: 'Title', type: 'text', required: true },
      { label: 'Author', type: 'text' },
      { label: 'Link', type: 'web link' },
      { label: 'Status', type: 'choice', options: ['Want to read', 'Reading', 'Finished'] },
      { label: 'Rating', type: 'whole number' },
    ],
  },
  {
    title: 'Event',
    thing: 'Event',
    fields: [
      { label: 'Title', type: 'text', required: true },
      { label: 'When', type: 'date', required: true },
      { label: 'Where', type: 'text' },
      { label: 'Host', type: 'person' },
    ],
  },
];

let nextId = 0;
const id = () => ++nextId;

/** A template's fields, as drafts to change */
const fromTemplate = (template: (typeof TEMPLATES)[number]): FieldDraft[] =>
  template.fields.map((f) => ({
    id: id(),
    label: f.label,
    type: f.type,
    options: f.options ?? [],
    required: !!f.required,
  }));

function draftsFrom(collection: NodeCollection | null): FieldDraft[] {
  if (!collection) return fromTemplate(TEMPLATES[0]!);
  const schema = collection.schema ?? {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, value]) => {
    const s = isObject(value) ? value : {};
    return {
      id: id(),
      was: name,
      label: typeof s.title === 'string' ? s.title : humanize(name),
      type: fieldTypeOf(s),
      options: Array.isArray(s.enum) ? s.enum.map(String) : [],
      required: required.has(name),
      original: s,
    };
  });
}

/** The name a field is stored under: its old one, or one made from what it's called */
const storedName = (field: FieldDraft) => field.was ?? fieldNameFrom(field.label);

/** A field's schema: kept exactly when nothing about its shape changed, else made from the picked type */
function schemaOf(field: FieldDraft): JsonSchema {
  const same =
    field.original &&
    field.type === fieldTypeOf(field.original) &&
    (field.type !== 'choice' ||
      JSON.stringify(field.options) ===
        JSON.stringify(Array.isArray(field.original.enum) ? field.original.enum : null));
  const base: JsonSchema =
    same || field.type === null ? { ...field.original } : fieldSchema(field.type, field.options);
  const name = storedName(field);
  const { title: _title, ...rest } = base;
  // A title only when the name alone wouldn't say it: "Assigned to" for `assignedTo` needs none.
  return field.label.trim() && field.label.trim() !== humanize(name)
    ? { ...rest, title: field.label.trim() }
    : rest;
}

/** Whether this account may change a collection's definition, and if not, why */
export function useMayRedefine(
  space: SpaceSummary,
  collection: NodeCollection | null,
): { may: boolean; reason: string } {
  const account = useAccount();
  const defines = useMayDefine(space.id, collection?.name ?? '');
  const people = peopleFrom(useProfiles(space.id));
  if (!collection) return { may: false, reason: '' };
  if (collection.definedBy === account.did || defines) return { may: true, reason: '' };
  const definer = collection.definedBy ? nameOf(collection.definedBy, people) : 'whoever made it';
  return {
    may: false,
    reason: `Only ${definer}, or someone the space lets define it, can change what ${collectionLabel(collection)} is.`,
  };
}

/** Makes a collection (null) or changes one, writing an ordinary definition and keeping what it doesn't understand */
export function CollectionEditor({
  space,
  collection,
  onDone,
}: {
  space: SpaceSummary;
  collection: NodeCollection | null;
  /** The collection's name once saved; null when cancelled or deleted */
  onDone: (name: string | null) => void;
}) {
  const node = useNode();
  const collections = useCollections(space.id);
  const making = collection === null;
  const [title, setTitle] = useState(collection ? collectionLabel(collection) : '');
  const [description, setDescription] = useState(collection?.description ?? '');
  const [fields, setFields] = useState<FieldDraft[]>(() => draftsFrom(collection));
  const [links, setLinks] = useState<LinkDraft[]>(() =>
    Object.entries(collection?.links ?? {}).map(([rel, d]) => ({
      id: id(),
      was: rel,
      label: humanize(rel).toLowerCase(),
      description: d.description ?? '',
      to: d.to === '*' ? [] : [...d.to],
      many: d.cardinality !== 'one',
    })),
  );
  const [onePer, setOnePer] = useState(false);
  const [template, setTemplate] = useState('Blank');
  const [picking, setPicking] = useState<number | null>(null);
  const { run, busy, error, setError } = useAction();
  const labels = useRef(new Map<number, HTMLInputElement>());

  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const name = collection?.name ?? `app.${slug || 'thing'}`;
  const thing = (title.trim() || 'entry').toLowerCase();
  const targets = collections.filter((c) => c.schema !== null && c.version !== null && c.name !== name);
  const about = links.find((l) => relFrom(l.label) === 'about' && !l.many && l.to.length > 0);

  const setField = (fid: number, patch: Partial<FieldDraft>) =>
    setFields((all) => all.map((f) => (f.id === fid ? { ...f, ...patch } : f)));
  const setLink = (lid: number, patch: Partial<LinkDraft>) =>
    setLinks((all) => all.map((l) => (l.id === lid ? { ...l, ...patch } : l)));
  const dragRow = useDragOrder((from, to) => setFields((all) => moved(all, from, to)));
  const addField = () => {
    const fresh: FieldDraft = { id: id(), label: '', type: 'text', options: [], required: false };
    setFields((all) => [...all, fresh]);
    globalThis.setTimeout(() => labels.current.get(fresh.id)?.focus(), 0);
  };
  const applyTemplate = (picked: (typeof TEMPLATES)[number]) => {
    setTemplate(picked.title);
    setFields(fromTemplate(picked));
    if (!title.trim() && picked.thing) setTitle(picked.thing);
  };

  const named = fields.filter((f) => f.label.trim() || f.was);
  const schema: JsonSchema = {
    ...(collection?.schema ?? { type: 'object' }),
    type: 'object',
    properties: Object.fromEntries(named.map((f) => [storedName(f), schemaOf(f)])),
    required: named.filter((f) => f.required).map(storedName),
  };

  const problem = (): string | null => {
    if (!title.trim()) return 'Give it a name';
    if (named.length === 0) return 'Give it at least one field';
    const names = named.map(storedName);
    const bad = named.find((f) => !storedName(f));
    if (bad) return `“${bad.label}” needs a name with a letter in it`;
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return `Two fields would both be called “${twice}”`;
    const empty = named.find((f) => f.type === 'choice' && f.options.length === 0);
    if (empty) return `Give “${empty.label}” some options to choose from`;
    const rels = links.map((l) => relFrom(l.label));
    if (rels.some((r) => !r)) return 'Every connection needs a name';
    if (new Set(rels).size !== rels.length) return 'Two connections have the same name';
    if (making && collections.some((c) => c.name === name))
      return `There is already a collection called ${title.trim()}`;
    return null;
  };

  const save = async () => {
    setError(null);
    const why = problem();
    if (why) return setError(why);
    const nextLinks: Record<string, LinkDeclaration> = Object.fromEntries(
      links.map((l) => [
        relFrom(l.label),
        {
          to: l.to.length ? [...l.to] : '*',
          cardinality: l.many ? 'many' : 'one',
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
        },
      ]),
    );
    // Who may change a record is the space's grants, not the definition's.
    const rules = {
      ...(collection?.rules ?? {}),
      ...(making && about && onePer ? { onePer: ['@author', 'link:about'] } : {}),
    };
    await run(async () => {
      await node.collections.define(space.id, {
        name,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        schema,
        ...(collection ? { history: collection.history } : {}),
        links: nextLinks,
        rules,
        ...(collection?.contract ? { contract: collection.contract } : {}),
      });
      onDone(name);
    });
  };
  const label = collection ? collectionLabel(collection) : '';
  // Only an empty collection: records left without a definition would lose their shape and rules.
  const cannotDelete = collection?.records
    ? `Delete its ${collection.records === 1 ? 'one record' : `${collection.records} records`} first. A definition can only be deleted once nothing uses it.`
    : null;
  const remove = (gone: NodeCollection) =>
    confirmThen(
      `It's removed for everyone in the space.`,
      { title: `Delete the definition of ${label}?`, yes: 'Delete' },
      () =>
        run(async () => {
          await node.collections.delete(space.id, gone.name);
          onDone(null);
        }),
    );

  const designer = (
    <div className={styles.designer}>
      <div className="stack" data-gap="loose">
        <section>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={making ? 'What are you keeping track of? A book, a chore, an idea…' : 'Name'}
            aria-label="Name"
            autoFocus={making}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A sentence on what it is (optional)"
            aria-label="Description"
          />
          {making && (
            <div className="row" data-gap="tight">
              <small>Start from</small>
              {TEMPLATES.map((t) => (
                <button
                  key={t.title}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  aria-pressed={template === t.title}
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <Heading title="Fields" about={`What every ${thing} has.`} />
          <ol role="list">
            {fields.map((field, i) => (
              <li key={field.id} className="stack" {...dragRow(i)}>
                <div className="row">
                  <Icon name="grip" />
                  {field.type === null ? (
                    <span className="tag" title="A shape this editor doesn't offer: kept exactly as it is">
                      {'{}'} as it is
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPicking(picking === field.id ? null : field.id)}
                      aria-expanded={picking === field.id}
                      aria-label={`Type of ${field.label || 'field'}: ${field.type}`}
                    >
                      <span className="tag">{FIELD_TYPE_INFO[field.type].mark}</span>
                      {field.type} ▾
                    </button>
                  )}
                  <input
                    ref={(el) => {
                      if (el) labels.current.set(field.id, el);
                      else labels.current.delete(field.id);
                    }}
                    value={field.label}
                    onChange={(e) => setField(field.id, { label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addField();
                      }
                    }}
                    placeholder="What is it called?"
                    aria-label={`Field ${i + 1} name`}
                    title={storedName(field) ? `Stored as ${storedName(field)}` : undefined}
                  />
                  <label title="Every one must have this filled in">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => setField(field.id, { required: e.target.checked })}
                    />
                    Must fill in
                  </label>
                  <button
                    type="button"
                    onClick={() => setFields((all) => all.filter((f) => f.id !== field.id))}
                    aria-label={`Remove ${field.label || `field ${i + 1}`}`}
                    data-intent="ghost"
                    data-icon
                  >
                    ✕
                  </button>
                </div>

                {picking === field.id && (
                  <div role="listbox" aria-label="Field type" className="grid">
                    {Object.keys(FIELD_TYPES)
                      .filter(isFieldType)
                      .map((type) => (
                        <button
                          key={type}
                          type="button"
                          role="option"
                          aria-selected={field.type === type}
                          onClick={() => {
                            setField(field.id, { type });
                            setPicking(null);
                          }}
                          data-intent="open"
                          className={`row ${styles.tile}`}
                        >
                          <span className="tag">{FIELD_TYPE_INFO[type].mark}</span>
                          <span className="stack" data-gap="tight">
                            <strong>{type}</strong>
                            <small>{FIELD_TYPE_INFO[type].hint}</small>
                          </span>
                        </button>
                      ))}
                  </div>
                )}

                {field.type === 'choice' && (
                  <Options options={field.options} onChange={(options) => setField(field.id, { options })} />
                )}
                {field.was &&
                  field.original &&
                  field.type !== null &&
                  field.type !== fieldTypeOf(field.original) && (
                    <small>
                      What's already written stays as it is; entries that don't fit the new type show as not
                      fitting.
                    </small>
                  )}
              </li>
            ))}
            <li>
              <button type="button" data-intent="open" onClick={addField}>
                + Add a field
              </button>
            </li>
          </ol>
        </section>

        <section>
          <Heading
            title="Connections"
            about={`What one ${thing} can point at: the poll a vote is about, the project a task is part of.`}
          />
          {links.length > 0 && (
            <ul role="list">
              {links.map((link) => (
                <li key={link.id} className="row">
                  <span>Each {thing} is</span>
                  <input
                    aria-label="Connection name"
                    value={link.label}
                    onChange={(e) => setLink(link.id, { label: e.target.value })}
                    placeholder="about, in, part of…"
                  />
                  <select
                    aria-label="How many"
                    value={link.many ? 'many' : 'one'}
                    onChange={(e) => setLink(link.id, { many: e.target.value === 'many' })}
                  >
                    <option value="one">one</option>
                    <option value="many">any number of</option>
                  </select>
                  <select
                    aria-label="What it points at"
                    value={link.to.length === 1 ? link.to[0] : link.to.length === 0 ? '*' : 'several'}
                    onChange={(e) => setLink(link.id, { to: e.target.value === '*' ? [] : [e.target.value] })}
                  >
                    <option value="*">anything</option>
                    {link.to.length > 1 && <option value="several">{link.to.length} kinds</option>}
                    {targets.map((c) => (
                      <option key={c.name} value={c.name}>
                        {collectionLabel(c).toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setLinks((all) => all.filter((l) => l.id !== link.id))}
                    aria-label={`Remove connection ${link.label}`}
                    data-intent="ghost"
                    data-icon
                    className={styles.end}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="row" data-gap="tight">
            {SUGGESTED_LINKS.filter((s) => !links.some((l) => relFrom(l.label) === s.rel)).map((s) => (
              <button
                key={s.rel}
                type="button"
                title={s.description}
                onClick={() =>
                  setLinks((all) => [
                    ...all,
                    {
                      id: id(),
                      label: humanize(s.rel).toLowerCase(),
                      description: s.description,
                      to: [],
                      many: s.rel !== 'about' && s.rel !== 'in' && s.rel !== 'partOf',
                    },
                  ])
                }
              >
                + {humanize(s.rel).toLowerCase()}
              </button>
            ))}
          </div>
        </section>

        <section>
          <Heading
            title="What it keeps to"
            about="Every device in the space enforces this. Who may add or change records is the space's roles."
          />
          {making && about && (
            <label>
              <input type="checkbox" checked={onePer} onChange={(e) => setOnePer(e.target.checked)} />
              One per person, per{' '}
              {collectionLabel(
                targets.find((c) => c.name === about.to[0]) ?? { name: about.to[0] ?? 'record' },
              ).toLowerCase()}{' '}
              — adding again changes theirs
            </label>
          )}
          {!making && collection?.rules.onePer && (
            <p>
              One per{' '}
              {collection.rules.onePer
                .map((part) =>
                  part === '@author' ? 'person' : humanize(part.replace(/^link:/, '')).toLowerCase(),
                )
                .join(', per ')}
              .
            </p>
          )}
        </section>

        {!making && (
          <small>
            Stored as <code>{name}</code>
            <Info label="Who this changes">
              Changes reach everyone in the space and apply to what's written from now on. Nothing already
              written is changed or deleted.
            </Info>
          </small>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="stack">
          <div className="row">
            <button type="button" data-intent="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : making ? `Create ${title.trim() || 'collection'}` : 'Save changes'}
            </button>
            <button type="button" data-intent="ghost" onClick={() => onDone(null)}>
              Cancel
            </button>
            {collection && (
              <button
                type="button"
                onClick={() => remove(collection)}
                disabled={busy || !!cannotDelete}
                title={cannotDelete ?? undefined}
                data-intent="danger"
                className={styles.end}
              >
                Delete
              </button>
            )}
          </div>
          {cannotDelete && <small>{cannotDelete}</small>}
        </div>
      </div>

      <aside aria-label="Preview" className={`stack ${styles.preview}`}>
        <div className="stack" data-gap="tight">
          <strong>Preview</strong>
          <small>The form for adding {title.trim() ? `a ${thing}` : 'one'}.</small>
        </div>
        <fieldset disabled>
          <SchemaForm
            key={JSON.stringify(schema)}
            schema={schema}
            submitLabel="Add"
            onSubmit={() => Promise.resolve()}
          />
        </fieldset>
      </aside>
    </div>
  );
  if (!collection) return designer;
  return (
    <section aria-label={`Edit what ${label} is`}>
      <div className="stack" data-gap="tight">
        <h2>Edit {label}</h2>
        <small>
          What every {label.toLowerCase()} is. Every device in the space checks new ones against it.
        </small>
      </div>
      {designer}
    </section>
  );
}

/** A choice's options, as chips, and a box to add one: Enter or a comma adds what's typed */
function Options({
  options,
  onChange,
}: {
  options: ReadonlyArray<string>;
  onChange: (options: ReadonlyArray<string>) => void;
}) {
  const [typing, setTyping] = useState('');
  const add = () => {
    const fresh = typing
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o && !options.includes(o));
    if (fresh.length) onChange([...options, ...fresh]);
    setTyping('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !typing && options.length) {
      onChange(options.slice(0, -1));
    }
  };
  return (
    <div className="row" data-gap="tight">
      {options.map((option) => (
        <span key={option} className="tag">
          {option}
          <button
            type="button"
            onClick={() => onChange(options.filter((o) => o !== option))}
            aria-label={`Remove ${option}`}
            data-intent="inline"
          >
            ✕
          </button>
        </span>
      ))}
      <input
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={options.length ? 'Add another…' : 'Type an option, then Enter'}
        aria-label="Add an option"
      />
    </div>
  );
}

function Heading({ title, about }: { title: string; about: string }) {
  return (
    <div className="stack" data-gap="tight">
      <h3>{title}</h3>
      <small>{about}</small>
    </div>
  );
}
