import { useEffect, useState, type ReactNode } from 'react';
import { PersonFace } from './PersonFace';
import { useNode, useLive, useProfiles, useCan } from '@minca/react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { file, reaction, comment, tag } from '@minca/core/schemas';
import {
  belonging,
  bodyOf,
  byRel,
  choicesFrom,
  collectionLabel,
  computedFieldsOf,
  fieldsOf,
  isObject,
  humanize,
  labelOf,
  recordLabel,
  tally,
  textOf,
  titleField,
  valueOf,
  valueKindOf,
  type Field,
  type LinkedByRel,
} from '../derive/schema-ui';
import { nameOf, peopleFrom, writerOf } from '../derive/people';
import { ago } from '@minca/ui/time';
import { SchemaForm, FieldInput } from './SchemaForm';
import { Value } from './Value';
import { Reactions } from './std/Reactions';
import { Tags } from './std/Tags';
import { Comments } from './std/Comments';
import { Attachments } from './std/Attachments';
import { LinkPicker } from './LinkPicker';
import styles from './RecordPanel.module.css';
import { useAction } from '@minca/app-shared/action';
import { Person } from './Person';
import { useDraft } from './useDraft';
import { Loading } from './Loading';
import { confirmThen } from '../confirm';

/** Standard collections with a place of their own on every record, so not offered as "+ Add …" */
const ANNOTATIONS = new Set<string>([reaction.name, comment.name, tag.name, file.name]);

/**
 * One record, as a form in a dialog: its fields edited in place, its links both ways, reactions, tags and
 * comments. A phone has it as a sheet from the bottom, as every dialog. Where what is behind should stay
 * usable, like Explore's map, it is a panel at the side instead (`scrim` off).
 */
export function RecordPanel({
  space,
  recordKey,
  collections,
  onOpen,
  onClose,
  onWriter,
  scrim = true,
  onOpenWith,
}: {
  space: SpaceSummary;
  recordKey: string;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
  onClose: () => void;
  /** Steps to whoever wrote it, like Explore does; without it their name opens their card */
  onWriter?: (did: string) => void;
  /** Dims what is behind; off where that should stay usable, like Explore's map */
  scrim?: boolean;
  /** Asks which app to open it in, where more than one can; undefined where not */
  onOpenWith?: (record: NodeRecord) => (() => void) | undefined;
}) {
  const node = useNode();
  const [adding, setAdding] = useState<{ collection: NodeCollection; rel: string } | null>(null);
  const { run, error } = useAction();
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Another record opened: what was being added to or linked from the last one goes.
  const [shownKey, setShownKey] = useState(recordKey);
  if (recordKey !== shownKey) {
    setShownKey(recordKey);
    setAdding(null);
    setLinking(null);
  }

  const people = peopleFrom(useProfiles(space.id));
  const data = useLive(
    space.id,
    async () => {
      const record = await node.records.get(space.id, recordKey);
      const linked = await node.records.linked(space.id, recordKey);
      // Its computed fields come with a query, worked out from what this device holds.
      const definition = record ? collections.find((c) => c.name === record.collection) : undefined;
      const computed =
        record && definition?.computed && Object.keys(definition.computed).length > 0
          ? ((
              await node.records.query(space.id, {
                collection: record.collection,
                where: { '@key': record.key },
              })
            ).records[0]?.computed ?? {})
          : {};
      const targets = record
        ? await Promise.all(
            record.links.map(async (link) => ({ link, target: await node.records.get(space.id, link.to) })),
          )
        : [];
      return { record, linked, targets, computed };
    },
    [recordKey],
  );

  // What this account may do here — by the record's rules and the space's.
  const may = { edit: useCan(space.id, 'edit', recordKey), delete: useCan(space.id, 'delete', recordKey) };
  const record = data?.record ?? null;
  const openWith = record ? onOpenWith?.(record) : undefined;
  const schemaOf = (name: string) => collections.find((c) => c.name === name)?.schema ?? null;
  const collection = record ? collections.find((c) => c.name === record.collection) : undefined;
  const schema = collection?.schema ?? null;
  const body = bodyOf(record);
  const title = titleField(schema);
  const fields = fieldsOf(schema).filter((f) => f.name !== title);
  const computed = computedFieldsOf(collection, collections);
  // What the body holds beyond its schema; a field the schema names but hides, like a position, is not extra.
  const declared = isObject(schema?.properties) ? schema.properties : {};
  const extra = Object.keys(body).filter((k) => k !== title && !Object.hasOwn(declared, k));
  const linkedHere: LinkedByRel =
    record && data
      ? byRel(
          record.links,
          data.targets.map((t) => t.target),
        )
      : {};
  const editable = !!may?.edit && record !== null && record.body !== null;

  /** Writes one field: the next version of the record, everything else unchanged */
  const save = async (name: string, value: unknown) => {
    if (!record) return;
    const next = { ...body };
    if (value === undefined || value === '') delete next[name];
    else next[name] = value;
    await run(() => node.records.update(space.id, record.key, next));
  };

  const linked = data?.linked ?? [];
  const addable = belonging(collections, record?.collection ?? '', ANNOTATIONS);
  // Reactions, comments and tags appear once the space has added them from the library.
  const uses = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  // Grouped by kind and by how they point here, so "Tasks · blocks" reads apart from "Tasks · about".
  const relTo = (r: NodeRecord) => r.links.find((l) => l.to === recordKey)?.rel ?? '';
  const pointing = groupBy(
    linked.filter((r) => !ANNOTATIONS.has(r.collection)),
    (r) => `${r.collection}|${relTo(r)}`,
  );

  /** Takes one link off this record: its next version, pointing at one thing less */
  const unlink = async (index: number) => {
    if (!record) return;
    await run(() =>
      node.records.update(space.id, record.key, record.body, {
        links: record.links.filter((_, i) => i !== index),
      }),
    );
  };

  return (
    <div
      className={scrim ? styles.backdrop : undefined}
      onMouseDown={(event) => scrim && event.target === event.currentTarget && onClose()}
    >
      <dialog
        open
        aria-modal={scrim || undefined}
        aria-label={record ? recordLabel(record, schema) : 'Record'}
        className={scrim ? styles.dialog : styles.panel}
      >
        <header>
          <div>
            <span className="tag">
              {collection ? collectionLabel(collection) : (record?.collection ?? 'Record')}
            </span>
          </div>
          {openWith && <button onClick={openWith}>Open with…</button>}
          <button onClick={onClose} aria-label="Close" data-intent="quiet" data-icon>
            ✕
          </button>
        </header>

        {!data ? (
          <Loading label="Opening" />
        ) : !record ? (
          <p className="empty">This record is gone — deleted, or not here yet.</p>
        ) : (
          <>
            <div className="stack">
              {title && editable ? (
                <InlineText
                  value={textOf(body[title] ?? '')}
                  onSave={(v) => save(title, v)}
                  ariaLabel="Title"
                  big
                />
              ) : (
                <h1>{recordLabel(record, schema)}</h1>
              )}
              <small className="row">
                <PersonFace did={record.createdBy ?? record.root ?? record.author} size={20} />
                <span>
                  {onWriter ? (
                    <button
                      type="button"
                      onClick={() => onWriter(record.createdBy ?? record.root ?? record.author)}
                      data-intent="inline"
                    >
                      {nameOf(record.createdBy ?? record.root, people)}
                    </button>
                  ) : (
                    <Person did={record.createdBy ?? record.root} />
                  )}
                  {record.recordsOnly && record.seq === 0 && ' via agent'}
                </span>
                <span>· {ago(record.createdAt)}</span>
                {record.seq > 0 && (
                  <span>
                    · edited {ago(record.updatedAt)}
                    {record.recordsOnly && ' via agent'}
                  </span>
                )}
              </small>
            </div>

            {uses(reaction.name) && (
              <Reactions
                space={space}
                target={record.key}
                targetAuthor={record.root}
                reactions={linked.filter((r) => r.collection === reaction.name)}
              />
            )}

            <dl className="stack" data-gap="loose">
              {fields
                .filter((f) => editable || !blank(body[f.name]))
                .map((f) => (
                  <Property key={f.name} label={f.label}>
                    <FieldEditor
                      field={f}
                      value={body[f.name]}
                      linked={linkedHere}
                      editable={editable}
                      onSave={(v) => save(f.name, v)}
                    />
                  </Property>
                ))}
              {extra.map((name) => (
                <Property key={name} label={humanize(name)}>
                  <Value value={body[name]} />
                </Property>
              ))}
              {computed
                .filter((f) => !blank(valueOf({ body, computed: data.computed }, f)))
                .map((f) => (
                  <Property key={f.name} label={`${f.label} ƒ`}>
                    <span
                      title={`Worked out by this device from what it holds — no one wrote it.\n${collection?.computed?.[f.name] ?? ''}`}
                    >
                      <Value
                        field={f}
                        value={valueOf({ body, computed: data.computed }, f)}
                        linked={linkedHere}
                      />
                    </span>
                  </Property>
                ))}
              {/* Each kind of link the definition allows, with what this record points at in it */}
              {[...new Set([...Object.keys(collection?.links ?? {}), ...record.links.map((l) => l.rel)])].map(
                (rel) => {
                  const here = data.targets.map((t, i) => ({ ...t, i })).filter((t) => t.link.rel === rel);
                  const declared = collection?.links[rel];
                  const full = declared?.cardinality === 'one' && here.length > 0;
                  // Nothing there and nothing to do about it says nothing.
                  if (here.length === 0 && !(editable && declared)) return null;
                  return (
                    <Property key={rel} label={humanize(rel)}>
                      <span className={styles.links}>
                        {here.map(({ link, target, i }) => (
                          <span key={link.to} className="row">
                            {target ? (
                              <button onClick={() => onOpen(target)} data-intent="inline">
                                {recordLabel(target, schemaOf(target.collection))} →
                              </button>
                            ) : (
                              <small>not here yet</small>
                            )}
                            {editable && (
                              <button
                                onClick={() => void unlink(i)}
                                aria-label={`Remove ${humanize(rel).toLowerCase()} link`}
                                title="Remove this link"
                                data-intent="quiet"
                                data-icon
                              >
                                ✕
                              </button>
                            )}
                          </span>
                        ))}
                        {editable && declared && linking !== rel && (
                          <button
                            data-intent="quiet"
                            onClick={() => setLinking(rel)}
                            title={declared.description}
                          >
                            {full ? 'Change…' : here.length ? '+ Add another' : '+ Add'}
                          </button>
                        )}
                      </span>
                    </Property>
                  );
                },
              )}
              {uses(tag.name) && (
                <Property label="Tags">
                  <Tags
                    space={space}
                    target={record.key}
                    tags={linked.filter((r) => r.collection === tag.name)}
                  />
                </Property>
              )}
            </dl>

            {editable && collection && linking && (
              <LinkPicker
                key={linking}
                space={space}
                record={record}
                collection={collection}
                collections={collections}
                initialRel={linking}
                onDone={() => setLinking(null)}
              />
            )}

            {record.conforms === false && (
              <p role="alert">
                Doesn't fit its definition: {record.issues?.map((i) => i.message).join('; ')}
              </p>
            )}
            {error && <p role="alert">{error}</p>}

            {[...pointing].map(([group, records]) => {
              const [name = '', rel = ''] = group.split('|');
              const c = collections.find((x) => x.name === name);
              const counted = c ? tally(c, records, record) : null;
              const labelFor = (r: NodeRecord) =>
                (counted
                  ? labelOf(counted.field, bodyOf(r)[counted.field.name], {
                      [choicesFrom(counted.field.schema)!.rel]: record,
                    })
                  : null) ?? recordLabel(r, schemaOf(r.collection));
              return (
                <section key={group} aria-label={`${c ? collectionLabel(c) : name} pointing here`}>
                  <h3>
                    {c ? collectionLabel(c) : name}
                    {rel && rel !== 'about' && <small> · {humanize(rel).toLowerCase()} this</small>}{' '}
                    <small>{records.length}</small>
                  </h3>
                  {counted && (
                    <div aria-label="Tally" className="stack">
                      {counted.counts.map(({ label, count }) => (
                        <div key={label} className={styles.tally}>
                          <span>{label}</span>
                          <progress value={count} max={Math.max(1, records.length)} />
                          <small>{count}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  <ul role="list">
                    {records.map((r) => (
                      <li key={r.key}>
                        <button data-intent="open" onClick={() => onOpen(r)} className="row">
                          <PersonFace did={r.root ?? r.author} size={18} />
                          <span className="truncate">{labelFor(r)}</span>
                          <small>
                            {writerOf(r, people)} · {ago(r.createdAt)}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {space.writable &&
              (adding ? (
                <section>
                  <h3>New {collectionLabel(adding.collection).toLowerCase()}</h3>
                  <SchemaForm
                    schema={adding.collection.schema}
                    linked={{ [adding.rel]: record }}
                    submitLabel="Add"
                    onCancel={() => setAdding(null)}
                    onSubmit={async (next) => {
                      await node.records.put(space.id, adding.collection.name, next, {
                        links: [{ rel: adding.rel, to: record.key }],
                      });
                      setAdding(null);
                    }}
                  />
                </section>
              ) : (
                addable.length > 0 && (
                  <div className="row">
                    {addable.map((a) => (
                      <button
                        key={`${a.collection.name}-${a.rel}`}
                        onClick={() => setAdding(a)}
                        title={a.collection.links[a.rel]?.description}
                      >
                        + Add {collectionLabel(a.collection).toLowerCase()}
                        {/* One kind added two ways, like a task under a column or a project, says which */}
                        {addable.filter((b) => b.collection.name === a.collection.name).length > 1 &&
                          ` · ${humanize(a.rel).toLowerCase()}`}
                      </button>
                    ))}
                  </div>
                )
              ))}

            {uses(file.name) && (
              <>
                <hr />
                <Attachments
                  space={space}
                  target={record.key}
                  attachments={linked.filter((r) => r.collection === file.name)}
                />
              </>
            )}

            {uses(comment.name) && (
              <>
                <hr />
                <Comments
                  space={space}
                  target={record.key}
                  targetAuthor={record.root}
                  comments={linked.filter((r) => r.collection === comment.name)}
                />
              </>
            )}

            <footer className="row" data-spread>
              <small>
                {record.verified ? 'Signature verified' : 'Not verified'}
                {record.encrypted && ' · encrypted'}
                {record.seq > 0 && ` · version ${record.seq + 1}`}
              </small>
              {may?.delete && (
                <button
                  data-intent="danger"
                  onClick={() =>
                    confirmThen(
                      'It is deleted for everyone in the space.',
                      { title: 'Delete this?', yes: 'Delete' },
                      () => node.records.delete(space.id, record.key).then(onClose),
                    )
                  }
                >
                  Delete
                </button>
              )}
            </footer>
          </>
        )}
      </dialog>
    </div>
  );
}

/** A value with nothing in it, which a field not yours to fill leaves out */
const blank = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** One field of the form: its name above, what it holds, or the field to change it, under it */
function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stack" data-gap="tight">
      <dt>
        <small>{label}</small>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A field edited where it stands: choices save at once, text on Enter or blur, the rest with a Save. */
function FieldEditor({
  field,
  value,
  linked,
  editable,
  onSave,
}: {
  field: Field;
  value: unknown;
  linked: LinkedByRel;
  editable: boolean;
  onSave: (value: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useDraft<unknown>(value);
  // In place, the property row already says what the field is.
  const bare: Field = {
    ...field,
    label: '',
    required: false,
    schema: { ...field.schema, description: undefined },
  };

  if (!editable)
    return (
      <div>
        <Value field={field} value={value} linked={linked} />
      </div>
    );

  if (field.kind === 'boolean') {
    return (
      <label>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => void onSave(e.target.checked)}
          aria-label={field.label}
        />
        <small>{value === true ? 'Yes' : 'No'}</small>
      </label>
    );
  }
  // Plain text is edited in place; a time, a link or a person shows as itself until clicked.
  if ((field.kind === 'text' || field.kind === 'longText') && !valueKindOf(field.schema)) {
    return (
      <InlineText
        value={typeof value === 'string' ? value : ''}
        onSave={(v) => onSave(v)}
        ariaLabel={field.label}
        multiline={field.kind === 'longText'}
      />
    );
  }
  if (field.kind === 'choice' || field.kind === 'number' || field.kind === 'integer') {
    // The form's own input, saving on change (choices) or on Enter/blur (numbers).
    const immediate = field.kind === 'choice';
    return (
      <div
        className={styles.bare}
        onBlur={() => !immediate && draft !== value && void onSave(draft)}
        onKeyDown={(e) => e.key === 'Enter' && !immediate && void onSave(draft)}
      >
        <FieldInput
          field={bare}
          value={draft}
          linked={linked}
          onChange={(v) => {
            setDraft(v);
            if (immediate) void onSave(v);
          }}
        />
      </div>
    );
  }
  return editing ? (
    <div className="stack">
      <FieldInput field={bare} value={draft} linked={linked} onChange={setDraft} />
      <div className="row">
        <button data-intent="primary" onClick={() => void onSave(draft).then(() => setEditing(false))}>
          Save
        </button>
        <button data-intent="quiet" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <button data-intent="open" onClick={() => setEditing(true)} aria-label={`Edit ${field.label}`}>
      <Value field={field} value={value} linked={linked} />
    </button>
  );
}

/** Text that looks like text until you click it; Enter or clicking away saves, Escape cancels */
function InlineText({
  value,
  onSave,
  ariaLabel,
  big,
  multiline,
}: {
  value: string;
  onSave: (value: string) => Promise<void> | void;
  ariaLabel: string;
  big?: boolean;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useDraft(value);
  const commit = () => {
    if (draft.trim() !== value.trim()) void onSave(draft.trim());
  };
  const common = {
    value: draft,
    'aria-label': ariaLabel,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    // What goes there, for a field still empty: "Add description"
    placeholder: big ? 'Untitled' : `Add ${ariaLabel.toLowerCase()}`,
    className: big ? styles.title : undefined,
  };
  return multiline ? (
    <textarea {...common} rows={3} onKeyDown={(e) => e.key === 'Escape' && setDraft(value)} />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function groupBy<T>(items: ReadonlyArray<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
