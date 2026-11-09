import { useState, type ReactNode } from 'react';
import { Icon } from '@minca/app-shared/Icon';
import { PersonFace } from './PersonFace';
import { useNode, useLive, useProfiles, useCan, useAccount } from '@minca/react';
import type { Filter, NodeCollection, NodeRecord, Query, QueryRecord, SpaceSummary } from '@minca/core';
import { reaction, comment, tag } from '@minca/core/schemas';
import {
  byRel,
  bodyOf,
  checkField,
  choicesFrom,
  choicesOf,
  collectionLabel,
  columnsOf,
  computedFieldsOf,
  fieldsOf,
  groupFields,
  isComputed,
  quickAddBody,
  recordLabel,
  textOf,
  titleField,
  labelOf,
  valueKindOf,
  valueOf,
  withComputed,
  type Field,
  type LinkedByRel,
} from '../derive/schema-ui';
import { nameOf, peopleFrom, type People } from '../derive/people';
import { ago } from '@minca/ui/time';
import { SchemaForm } from './SchemaForm';
import { CollectionEditor, useMayRedefine } from './CollectionDesigner';
import { Value } from './Value';
import { reactionSummary } from './std/Reactions';
import { tagLabel } from './std/Tags';
import { useAction } from '@minca/app-shared/action';
import { Lane } from './Lane';
import { Person } from './Person';
import { useDraft } from './useDraft';
import { usePopover } from './usePopover';
import { QueryBuilder, PAGE_SIZES } from './QueryBuilder';
import { NEWEST_FIRST, type Sort } from '../derive/filters';
import { clauseFields, whereOf, type Clause } from '../derive/conditions';
import { LAYOUT_LABELS, LAYOUTS, type Layout, type Look } from '../derive/look';
import styles from './CollectionView.module.css';
import table from './table.module.css';

const LAYOUT_ICONS = { table: 'table', board: 'board', cards: 'card', list: 'menu' } as const;

interface Row {
  readonly record: QueryRecord;
  readonly linked: LinkedByRel;
}

interface Page {
  readonly rows: Row[];
  /** Where the page after this one starts; null on the last */
  readonly next: string | null;
}

/**
 * One collection to search, add to, and see as a table, a board, cards or a list, all from its schema.
 * How it is looked at is whoever draws it's to keep: on this device, or in a view everyone shares.
 */
export function CollectionView({
  space,
  name,
  collection,
  collections,
  look,
  onLook,
  onOpen,
}: {
  space: SpaceSummary;
  name: string;
  collection: NodeCollection | null;
  /** The space's collections: what a computed field reads, to know its type */
  collections: ReadonlyArray<NodeCollection>;
  look: Look;
  onLook: (look: Look) => void;
  onOpen: (record: NodeRecord) => void;
}) {
  const node = useNode();
  const schema = collection?.schema ?? null;
  // Worked out on this device from what links to each record: shown, filtered and sorted on, never written.
  const computed = computedFieldsOf(collection, collections);
  const title = titleField(schema);
  const groups = groupFields(schema);
  const group = groups.find((f) => f.name === look.groupBy) ?? groups[0] ?? null;
  const { layout } = look;
  const clauses = look.filters ?? [];
  const sort = look.sort ?? NEWEST_FIRST;
  const everyField = [...fieldsOf(schema), ...computed];
  const shownFields = look.fields
    ? look.fields.flatMap((field) => everyField.filter((f) => f.name === field))
    : [...columnsOf(schema), ...shortOf(computed)];
  const [search, setSearchText] = useState('');
  const [pageSize, setPageSizeTo] = useState<number>(PAGE_SIZES[1]);
  // Where each page seen so far starts: the first at the beginning, each next one from the page before.
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);
  // A different question starts again from its first page.
  const restarting =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setCursors([null]);
    };
  const setSearch = restarting(setSearchText);
  const setClauses = restarting((filters: ReadonlyArray<Clause>) => onLook({ ...look, filters }));
  const setSort = restarting((next: Sort) => onLook({ ...look, sort: next }));
  const setPageSize = restarting(setPageSizeTo);
  const setLayout = (next: Layout) => onLook({ ...look, layout: next });
  const [adding, setAdding] = useState<Record<string, unknown> | null>(null);
  const people = peopleFrom(useProfiles(space.id));
  const { did } = useAccount();
  const mayCreate = useCan(space.id, 'create', name);
  const [defining, setDefining] = useState(false);
  const redefine = useMayRedefine(space, collection);
  // Records that can be about anything — comments, reactions, tags — are added on the record they're about.
  const onOthers = Object.values(collection?.links ?? {}).some((l) => l.to === '*');

  // Choices that live in a linked record (a vote's poll) need that record to show their label.
  const needsLinked = shownFields.some((f) => choicesFrom(f.schema));
  const fields = clauseFields({ schema: withComputed(schema, computed), topics: [] }, { query: true });
  const picked = whereOf(clauses, did);
  const parts: Filter[] = [
    ...(search.trim() && title ? [{ [title]: { $contains: search.trim() } }] : []),
    ...(picked ? [picked] : []),
  ];
  const where: Filter | undefined = parts.length > 1 ? { $and: parts } : parts[0];
  const cursor = cursors[cursors.length - 1] ?? null;
  const query: Query = {
    collection: name,
    ...(where ? { where } : {}),
    sort: { [sort.field]: sort.direction },
    limit: pageSize,
  };
  const queryText = JSON.stringify(query);
  const page = useLive(
    space.id,
    async (): Promise<Page> => {
      const { records, cursor: next } = await node.records.query(space.id, {
        ...query,
        ...(cursor ? { cursor } : {}),
        include: {
          reactions: { rel: 'about', from: reaction.name },
          comments: { rel: 'about', from: comment.name, count: true },
          tags: { rel: 'about', from: tag.name },
        },
      });
      const rows = await Promise.all(
        records.map(async (record) => ({
          record,
          linked: needsLinked
            ? byRel(
                record.links,
                await Promise.all(record.links.map((l) => node.records.get(space.id, l.to))),
              )
            : {},
        })),
      );
      return { rows, next };
    },
    [queryText, cursor, needsLinked],
  );
  const rows = page?.rows;
  const filtered = where !== undefined;
  const from = (cursors.length - 1) * pageSize;

  const add = async (body: unknown) => {
    await node.records.put(space.id, name, body);
    setAdding(null);
  };

  const label = collection ? collectionLabel(collection) : name;
  const visible = (rows ?? []).filter((r) => r.record.body !== null);
  const shown: Shown = { rows: visible, schema, fields: shownFields, people, space, onOpen };

  if (defining && collection) {
    return <CollectionEditor space={space} collection={collection} onDone={() => setDefining(false)} />;
  }

  return (
    <section aria-label={label}>
      <header className={styles.head}>
        <div className="stack" data-gap="tight">
          <h2>{label}</h2>
          <small>{collection?.description ?? <code>{name}</code>}</small>
        </div>
        <div className={`row ${styles.tools}`}>
          {title && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              aria-label={`Search ${label}`}
              className={styles.search}
            />
          )}
          {layout === 'board' && groups.length > 1 && group && (
            <label className="row">
              Columns by
              <select value={group.name} onChange={(e) => onLook({ ...look, groupBy: e.target.value })}>
                {groups.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {collection?.schema && (
            <button
              onClick={() => setDefining(true)}
              disabled={!redefine.may}
              title={redefine.may ? 'Change its fields and the kinds of links it has' : redefine.reason}
            >
              Edit definition
            </button>
          )}
          {everyField.length > 0 && (
            <FieldPicker
              fields={everyField}
              shown={shownFields}
              onShown={(fields) => onLook({ ...look, fields: fields.map((f) => f.name) })}
            />
          )}
          <div role="tablist" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button key={l} role="tab" aria-selected={layout === l} onClick={() => setLayout(l)}>
                <Icon name={LAYOUT_ICONS[l]} size={14} />
                {LAYOUT_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {onOthers && <small>These are added on the record they're about — open any record to add one.</small>}

      {mayCreate &&
        !onOthers &&
        (adding ? (
          <article>
            <SchemaForm
              schema={schema}
              initial={adding}
              submitLabel="Add"
              onCancel={() => setAdding(null)}
              onSubmit={add}
            />
          </article>
        ) : (
          <QuickAdd label={label} schema={schema} onAdd={add} onMore={(prefill) => setAdding(prefill)} />
        ))}

      {(collection?.records ?? 0) > 0 && (
        <QueryBuilder
          fields={fields}
          clauses={clauses}
          onClauses={setClauses}
          sort={sort}
          onSort={setSort}
          pageSize={pageSize}
          onPageSize={setPageSize}
          people={people}
          me={did}
          query={query}
        />
      )}

      {rows && visible.length === 0 && (
        <p className="empty">{filtered ? 'Nothing matches.' : `No ${label.toLowerCase()} yet.`}</p>
      )}

      {visible.length > 0 && layout === 'list' && <ListLayout {...shown} />}
      {visible.length > 0 && layout === 'table' && <TableLayout {...shown} />}
      {visible.length > 0 && layout === 'cards' && <CardsLayout {...shown} />}
      {layout === 'board' && !group && (
        <p className="empty">
          A board makes a column for each option of a choice field — like a status of To do, Doing and Done.{' '}
          {label} has no field like that yet{redefine.may ? ' — add one with Edit definition' : ''}.
        </p>
      )}
      {visible.length > 0 && layout === 'board' && group && <BoardLayout {...shown} field={group} />}

      {page && (cursors.length > 1 || page.next) && (
        <nav aria-label="Pages" className="row" data-spread>
          <small>
            {visible.length ? `${from + 1}–${from + visible.length}` : 'None'}
            {!filtered && collection ? ` of ${collection.records}` : ''}
          </small>
          <button
            data-intent="ghost"
            onClick={() => setCursors(cursors.slice(0, -1))}
            disabled={cursors.length <= 1}
          >
            ← Previous
          </button>
          <button
            data-intent="ghost"
            onClick={() => page.next && setCursors([...cursors, page.next])}
            disabled={!page.next}
          >
            Next →
          </button>
        </nav>
      )}
    </section>
  );
}

/** One line to add a record by its title; "More fields" when there is more to say */
function QuickAdd({
  label,
  schema,
  onAdd,
  onMore,
}: {
  label: string;
  schema: NodeCollection['schema'];
  onAdd: (body: unknown) => Promise<void>;
  onMore: (prefill: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState('');
  const { run, error, clear } = useAction();
  const title = titleField(schema);
  const noun = label.toLowerCase();

  if (!title) {
    return (
      <button data-intent="primary" className={styles.start} onClick={() => onMore({})}>
        + New {noun}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value) return;
        const body = quickAddBody(schema, value);
        clear();
        // Something else is required that has no empty value: the full form, with the title filled in.
        if (!body) return onMore({ [title]: value });
        void run(async () => {
          await onAdd(body);
          setText('');
        });
      }}
      className="stack"
    >
      <div className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Add ${noun}…`}
          aria-label={`Add ${noun}`}
        />
        <button type="button" onClick={() => onMore(text.trim() ? { [title]: text.trim() } : {})}>
          More fields
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

// ─── Layouts ───────────────────────────────────────────────────────

/** What every layout shows: the rows of a page, and how to read and open them */
interface Shown {
  readonly rows: Row[];
  readonly schema: NodeCollection['schema'];
  /** The fields the look shows, in its order */
  readonly fields: ReadonlyArray<Field>;
  readonly people: People;
  readonly space: SpaceSummary;
  readonly onOpen: (r: NodeRecord) => void;
}

function ListLayout({ rows, schema, fields, people, space, onOpen }: Shown) {
  const node = useNode();
  // Without a yes/no field to tick, a computed one shows as a box that ticks itself.
  const check = checkField(schema) ?? fields.find((f) => f.kind === 'boolean' && isComputed(f)) ?? null;
  const meta = besideTitle(fields, schema).filter((f) => f.name !== check?.name);
  return (
    <ul role="list">
      {rows.map(({ record, linked }) => {
        const body = bodyOf(record);
        const done = check ? valueOf(record, check) === true : false;
        return (
          <li key={record.key} className="row">
            {check && (
              <Check
                checked={done}
                disabled={!space.writable || isComputed(check)}
                label={`${check.label}: ${recordLabel(record, schema)}`}
                onChange={(checked) =>
                  node.records.update(space.id, record.key, { ...body, [check.name]: checked })
                }
              />
            )}
            <button data-intent="open" className="row" data-spread onClick={() => onOpen(record)}>
              <span className="stack" data-gap="tight">
                <strong>{done ? <s>{recordLabel(record, schema)}</s> : recordLabel(record, schema)}</strong>
                <Meta record={record} fields={meta} linked={linked} />
              </span>
              <Signals record={record} people={people} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A checkbox that answers at once, and settles when the new version comes back (or fails) */
function Check({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => Promise<unknown>;
}) {
  const [shown, setShown] = useDraft(checked);
  return (
    <input
      type="checkbox"
      checked={shown}
      disabled={disabled}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.target.checked;
        setShown(next);
        void onChange(next).catch(() => setShown(!next));
      }}
    />
  );
}

/** A grid of the shown fields; a plain value is changed in its cell, the rest in the record opened from its row */
function TableLayout({ rows, schema, fields, space, onOpen }: Shown) {
  const node = useNode();
  const { run, error } = useAction();
  const save = (record: QueryRecord, field: Field, value: unknown) =>
    run(() => node.records.update(space.id, record.key, withValue(bodyOf(record), field.name, value)));
  return (
    <div className="stack" data-gap="tight">
      <div className={table.table}>
        <table>
          <thead>
            <tr>
              <th aria-label="Open" />
              {fields.length ? (
                fields.map((c) => (
                  <th key={c.name} title={isComputed(c) ? COMPUTED_HINT : undefined}>
                    {c.label}
                    {isComputed(c) && ' ƒ'}
                  </th>
                ))
              ) : (
                <th>Record</th>
              )}
              <th>By</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ record, linked }) => (
              <tr key={record.key}>
                <td>
                  <button
                    data-intent="ghost"
                    data-icon
                    onClick={() => onOpen(record)}
                    aria-label={`Open ${recordLabel(record, schema)}`}
                  >
                    <Icon name="expand" size={14} />
                  </button>
                </td>
                {fields.length ? (
                  fields.map((c) => (
                    <td key={c.name}>
                      {space.writable && editableInCell(c) ? (
                        <Cell
                          field={c}
                          value={valueOf(record, c)}
                          onSave={(value) => save(record, c, value)}
                        />
                      ) : (
                        <Value field={c} value={valueOf(record, c)} linked={linked} compact />
                      )}
                    </td>
                  ))
                ) : (
                  <td>{recordLabel(record, schema)}</td>
                )}
                <td>
                  <Person did={record.createdBy ?? record.root} />
                </td>
                <td>{ago(record.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** A body with one field set, or taken out when it is emptied */
function withValue(body: Record<string, unknown>, name: string, value: unknown): Record<string, unknown> {
  const next = { ...body };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}

/** Kinds a cell can change in place: one plain value, typed or picked; anything richer opens the record */
const editableInCell = (field: Field): boolean =>
  !isComputed(field) &&
  !valueKindOf(field.schema) &&
  (['text', 'longText', 'number', 'integer', 'boolean'].includes(field.kind) ||
    (field.kind === 'choice' && !choicesFrom(field.schema)));

/** One cell of a table, changed where it is: a tick at once, anything else from a click until Enter or leaving it */
function Cell({
  field,
  value,
  onSave,
}: {
  field: Field;
  value: unknown;
  onSave: (value: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  if (field.kind === 'boolean') {
    return (
      <Check
        checked={value === true}
        disabled={false}
        label={field.label}
        onChange={async (checked) => {
          if (!(await onSave(checked))) throw new Error('Not saved');
        }}
      />
    );
  }
  if (!editing) {
    return (
      <button data-intent="inline" className={styles.cell} onClick={() => setEditing(true)}>
        <Value field={field} value={value} compact />
      </button>
    );
  }
  const finish = (next: unknown) => {
    setEditing(false);
    if (next !== value) void onSave(next);
  };
  const choices = choicesOf(field);
  if (choices) {
    return (
      <select
        autoFocus
        aria-label={field.label}
        defaultValue={String(choices.findIndex((c) => c.value === value))}
        onChange={(e) => finish(choices[Number(e.target.value)]?.value)}
        onBlur={() => setEditing(false)}
      >
        <option value="-1">—</option>
        {choices.map((c, i) => (
          <option key={i} value={i}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  const numeric = field.kind === 'number' || field.kind === 'integer';
  const typed = (text: string): unknown => {
    if (text.trim() === '') return undefined;
    return numeric ? Number(text) : text;
  };
  return (
    <input
      autoFocus
      aria-label={field.label}
      type={numeric ? 'number' : 'text'}
      step={field.kind === 'integer' ? 1 : 'any'}
      defaultValue={value === undefined || value === null ? '' : textOf(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(typed(e.currentTarget.value));
        if (e.key === 'Escape') setEditing(false);
      }}
      onBlur={(e) => finish(typed(e.currentTarget.value))}
    />
  );
}

/** A card for each record: its title, then each shown field under its name */
function CardsLayout({ rows, schema, fields, people, onOpen }: Shown) {
  const rest = besideTitle(fields, schema);
  return (
    <div className={`grid ${styles.cards}`}>
      {rows.map(({ record, linked }) => (
        <button
          key={record.key}
          type="button"
          data-intent="open"
          className="stack"
          data-gap="tight"
          onClick={() => onOpen(record)}
          aria-label={recordLabel(record, schema)}
        >
          <strong>{recordLabel(record, schema)}</strong>
          {rest
            .filter((f) => !isBlank(valueOf(record, f)))
            .map((f) => (
              <span key={f.name} className="row" data-gap="tight">
                <small>{f.label}</small>
                <Value field={f} value={valueOf(record, f)} linked={linked} compact />
              </span>
            ))}
          <Signals record={record} people={people} />
        </button>
      ))}
    </div>
  );
}

/** Which fields to show, ticked from all of them, in the order they are defined */
function FieldPicker({
  fields,
  shown,
  onShown,
}: {
  fields: ReadonlyArray<Field>;
  shown: ReadonlyArray<Field>;
  onShown: (fields: ReadonlyArray<Field>) => void;
}) {
  const { open, setOpen, root } = usePopover();
  const isShown = (field: Field) => shown.some((f) => f.name === field.name);
  return (
    <div ref={root} className="anchor down">
      <button onClick={() => setOpen((was) => !was)} aria-expanded={open} aria-haspopup="menu">
        Fields
        <small>{shown.length}</small>
      </button>
      {open && (
        <menu role="menu" aria-label="Fields shown">
          {fields.map((field) => (
            <li key={field.name}>
              <label className="row">
                <input
                  type="checkbox"
                  checked={isShown(field)}
                  onChange={(e) =>
                    onShown(fields.filter((f) => (f.name === field.name ? e.target.checked : isShown(f))))
                  }
                />
                {field.label}
                {isComputed(field) && ' ƒ'}
              </label>
            </li>
          ))}
        </menu>
      )}
    </div>
  );
}

/** Columns by a fixed-choice field; drag a card to another column to change it */
function BoardLayout({ rows, schema, fields, field, people, space, onOpen }: Shown & { field: Field }) {
  const node = useNode();
  const [over, setOver] = useState<string | null>(null);
  const choices = choicesOf(field) ?? [];
  const columns = [
    ...choices.map((c, i) => ({ id: String(i), label: c.label, value: c.value })),
    { id: 'none', label: `No ${field.label.toLowerCase()}`, value: undefined },
  ];
  const meta = besideTitle(fields, schema).filter((f) => f.name !== field.name);
  const columnOf = (r: Row) => {
    const i = choices.findIndex((c) => c.value === bodyOf(r.record)[field.name]);
    return i < 0 ? 'none' : String(i);
  };
  const move = (key: string, value: unknown) => {
    const row = rows.find((r) => r.record.key === key);
    if (!row) return;
    // Refused by the record's rules — it stays where it was.
    void node.records.update(space.id, key, withValue(bodyOf(row.record), field.name, value)).catch(() => {});
  };

  return (
    <div className="lanes">
      {columns
        .filter((c) => c.id !== 'none' || rows.some((r) => columnOf(r) === 'none'))
        .map((column) => {
          const cards = rows.filter((r) => columnOf(r) === column.id);
          return (
            <Lane
              key={column.id}
              aria-label={`Column ${column.label}`}
              name={column.label}
              count={cards.length}
              over={over === column.id}
              onDragOver={(e) => {
                if (!space.writable) return;
                e.preventDefault();
                setOver(column.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                move(e.dataTransfer.getData('text/plain'), column.value);
              }}
            >
              {cards.map(({ record, linked }) => (
                <button
                  key={record.key}
                  type="button"
                  data-intent="open"
                  draggable={space.writable}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', record.key)}
                  onClick={() => onOpen(record)}
                  aria-label={recordLabel(record, schema)}
                >
                  <strong>{recordLabel(record, schema)}</strong>
                  <Meta record={record} fields={meta} linked={linked} />
                  <Signals record={record} people={people} />
                </button>
              ))}
            </Lane>
          );
        })}
    </div>
  );
}

// ─── Row pieces ────────────────────────────────────────────────────

/** Said wherever a computed field shows: whose view it is */
const COMPUTED_HINT = 'Worked out by this device from what it holds — no one wrote it';

/** Whether a value has nothing to show */
const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** The shown fields that go beside a record's title, which it shows already */
const besideTitle = (fields: ReadonlyArray<Field>, schema: NodeCollection['schema']): ReadonlyArray<Field> =>
  fields.filter((f) => f.name !== titleField(schema));

/** Computed fields short enough for a row or a cell, at most three */
const shortOf = (computed: ReadonlyArray<Field>): ReadonlyArray<Field> =>
  computed
    .filter((f) => ['text', 'number', 'integer', 'boolean', 'choice', 'list'].includes(f.kind))
    .slice(0, 3);

/** A row's short fields and tags, as small chips */
function Meta({
  record,
  fields,
  linked,
}: {
  record: QueryRecord;
  fields: ReadonlyArray<Field>;
  linked: LinkedByRel;
}) {
  const included = record.included?.tags;
  const tags = typeof included === 'object' ? included : [];
  const parts: ReactNode[] = [];
  for (const f of fields) {
    const value = valueOf(record, f);
    if (isBlank(value)) continue;
    const shown = labelOf(f, value, linked) ?? (Array.isArray(value) ? value.join(', ') : textOf(value));
    parts.push(
      <small key={f.name}>
        <span title={isComputed(f) ? COMPUTED_HINT : undefined}>{f.label}</span> {shown}
      </small>,
    );
  }
  for (const t of tags) {
    parts.push(
      <span key={t.key} className="tag">
        #{tagLabel(t)}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return <span className="row">{parts}</span>;
}

/** Reactions, comment count, who and when — the right-hand side of a row */
function Signals({ record, people }: { record: QueryRecord; people: People }) {
  const reactions = reactionSummary(record.included?.reactions);
  const comments = typeof record.included?.comments === 'number' ? record.included.comments : 0;
  return (
    <small className="row">
      {reactions && <span>{reactions}</span>}
      {comments > 0 && <span aria-label={`${comments} comments`}>💬 {comments}</span>}
      <span className="row" data-gap="tight" title={nameOf(record.createdBy ?? record.root, people)}>
        <PersonFace did={record.createdBy ?? record.root ?? record.author} size={18} />
        {ago(record.createdAt)}
      </span>
    </small>
  );
}
