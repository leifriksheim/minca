import { Fragment, useState } from 'react';
import { itemKindOf, labelOf, textOf, valueKindOf, type Field, type LinkedByRel } from '../derive/schema-ui';
import { byKind, PeopleValue } from './KindValue';
import styles from './Value.module.css';

/** Text longer than this folds away behind "Show": a screen's HTML is a field too */
const LONG = 400;
/** Nested data this deep is shown as JSON: past it, indentation stops helping */
const DEEPEST = 5;

/**
 * A field's value, read-only, in whatever form suits its kind — a choice by its label, not its stored value.
 * `compact` is for a table cell or a card line: nested data as a count, long text cut short.
 */
export function Value({
  field,
  value,
  linked,
  compact = false,
}: {
  field?: Field;
  value: unknown;
  linked?: LinkedByRel;
  compact?: boolean;
}) {
  if (value === undefined || value === null || value === '') return <small>—</small>;
  const label = field ? labelOf(field, value, linked) : null;
  if (label !== null) return <span>{label}</span>;
  const kind = field ? valueKindOf(field.schema) : null;
  const shown = kind ? byKind(kind, value, compact) : null;
  if (shown !== null) return shown;
  const items = field ? itemKindOf(field.schema) : null;
  if (items === 'did' && Array.isArray(value)) return <PeopleValue value={value} />;
  if ((items === 'file' || items === 'image') && Array.isArray(value))
    return (
      <span className="row" data-gap="tight">
        {value.map((item, i) => (
          <span key={i}>{byKind(items, item, compact)}</span>
        ))}
      </span>
    );
  return <Plain value={value} compact={compact} longText={field?.kind === 'longText'} depth={0} />;
}

function Plain({
  value,
  compact = false,
  longText = false,
  depth,
}: {
  value: unknown;
  compact?: boolean;
  longText?: boolean;
  depth: number;
}) {
  if (value === undefined || value === null || value === '') return <small>—</small>;
  if (typeof value === 'boolean') return <span>{value ? '✓ yes' : '✗ no'}</span>;
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object'))
    return <span>{value.join(', ')}</span>;
  if (typeof value === 'object') {
    if (compact) return <small>{sizeOf(value)}</small>;
    if (depth >= DEEPEST) return <pre>{JSON.stringify(value, null, 2)}</pre>;
    return Array.isArray(value) ? (
      <Items items={value} depth={depth} />
    ) : (
      <Fields entries={Object.entries(value)} depth={depth} />
    );
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value))
    return <span>{new Date(value).toLocaleString()}</span>;
  if (typeof value === 'string' && value.length > LONG)
    return compact ? <span>{value.slice(0, 80)}…</span> : <LongText text={value} />;
  if (longText) return <span className={styles.long}>{textOf(value)}</span>;
  return <span>{textOf(value)}</span>;
}

/** Whether a value needs room of its own: an object, or a list holding one */
const nested = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  (!Array.isArray(value) || value.some((v) => v !== null && typeof v === 'object'));

/** "3 fields", "2 items": what folded data holds */
function sizeOf(value: object): string {
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  return Array.isArray(value)
    ? `${count} ${count === 1 ? 'item' : 'items'}`
    : `${count} ${count === 1 ? 'field' : 'fields'}`;
}

/**
 * An object's fields. A plain value sits beside its name; nested data goes below it, a step in,
 * so each level costs a little indent rather than a column. Past the first level it starts folded.
 */
function Fields({ entries, depth }: { entries: ReadonlyArray<[string, unknown]>; depth: number }) {
  return (
    <div className={styles.fields}>
      {entries.map(([key, value]) =>
        nested(value) && typeof value === 'object' && value !== null ? (
          <details key={key} open={depth < 1} className={styles.fold}>
            <summary>
              {key} <small>{sizeOf(value)}</small>
            </summary>
            <div className={styles.inner}>
              <Plain value={value} depth={depth + 1} />
            </div>
          </details>
        ) : (
          <Fragment key={key}>
            <small>{key}</small>
            <span>
              <Plain value={value} depth={depth + 1} />
            </span>
          </Fragment>
        ),
      )}
    </div>
  );
}

/** A list of objects, each set apart by a rule on its left */
function Items({ items, depth }: { items: ReadonlyArray<unknown>; depth: number }) {
  return (
    <div className="stack">
      {items.map((item, i) => (
        <div key={i} className={styles.inner}>
          <Plain value={item} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

/** Long text folded away, with its size, until asked for */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const size = new TextEncoder().encode(text).length;
  const kb = size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} bytes`;
  return (
    <span className="stack" data-gap="tight">
      <small>
        {open ? null : `${text.slice(0, 120).replace(/\s+/g, ' ')}…`}{' '}
        <button data-intent="inline" onClick={() => setOpen((was) => !was)}>
          {open ? 'Hide' : `Show (${kb})`}
        </button>
      </small>
      {open && <pre className={styles.text}>{text}</pre>}
    </span>
  );
}
