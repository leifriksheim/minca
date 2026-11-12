import { useState, type ReactNode } from 'react';
import type { NodeCollection, QueryRecord } from '@minca/core';
import { choicesOf, recordLabel, textOf, valueKindOf, itemKindOf, type Field } from '../../derive/schema-ui';
import { moneyText, safeHref, whenText } from '../../derive/kinds';
import { nameOf, type People } from '../../derive/people';
import { PersonFace } from '../PersonFace';
import { Value } from '../Value';
import { cellEditOf, hueOf, hueOfText, oneLine } from './fields';
import styles from './Sheets.module.css';

/** Whether a value has nothing to show */
export const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** A field's value as a sheet shows it: options as coloured pills, people by face and name, text on one line */
export function CellValue({ field, value, people }: { field: Field; value: unknown; people: People }) {
  if (isBlank(value)) return null;
  const kind = valueKindOf(field.schema);
  if (kind === 'did' && typeof value === 'string') return <Someone did={value} people={people} />;
  if (itemKindOf(field.schema) === 'did' && Array.isArray(value))
    return (
      <span className={styles.values}>
        {value
          .filter((did) => typeof did === 'string')
          .map((did) => (
            <Someone key={did} did={did} people={people} />
          ))}
      </span>
    );
  if (kind === 'when' || kind === 'day') return <span>{whenText(value) ?? ''}</span>;
  if (kind === 'money') return <span>{moneyText(value) ?? ''}</span>;
  if (kind === 'url') return <WebLink value={value} />;
  if (kind) return <Value field={field} value={value} compact />;
  if (field.kind === 'choice') {
    const label = choicesOf(field)?.find((choice) => choice.value === value)?.label ?? String(value);
    return <Pill hue={hueOf(field, value)}>{label}</Pill>;
  }
  if (field.kind === 'boolean')
    return <input type="checkbox" checked={value === true} readOnly tabIndex={-1} />;
  if (field.kind === 'list' && Array.isArray(value))
    return (
      <span className={styles.values}>
        {value.map((item, i) => (
          <Pill key={i} hue={hueOfText(textOf(item))}>
            {oneLine(textOf(item))}
          </Pill>
        ))}
      </span>
    );
  if (typeof value === 'object') return <Value field={field} value={value} compact />;
  return <span>{oneLine(textOf(value))}</span>;
}

/** An option, tinted by the hue it always has */
export function Pill({ hue, children }: { hue: number; children: ReactNode }) {
  return (
    <span className={styles.pill} data-hue={hue}>
      {children}
    </span>
  );
}

/** The records a row is linked with, each a pill by its title in the hue it always has; pressed, it opens */
export function RelatedRecords({
  records,
  collections,
  onOpen,
}: {
  records: ReadonlyArray<QueryRecord>;
  collections: ReadonlyArray<NodeCollection>;
  /** None where the pills sit inside something already pressable, like a card */
  onOpen?: (record: QueryRecord) => void;
}) {
  const titleOf = (record: QueryRecord) =>
    recordLabel(record, collections.find((c) => c.name === record.collection)?.schema ?? null);
  return (
    <span className={styles.values}>
      {records.map((record) =>
        onOpen ? (
          <button
            key={record.key}
            className={styles.pill}
            data-hue={hueOfText(record.key)}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(record);
            }}
          >
            {titleOf(record)}
          </button>
        ) : (
          <Pill key={record.key} hue={hueOfText(record.key)}>
            {titleOf(record)}
          </Pill>
        ),
      )}
    </span>
  );
}

function Someone({ did, people }: { did: string; people: People }) {
  return (
    <span className={styles.someone}>
      <PersonFace did={did} size={18} round />
      {nameOf(did, people)}
    </span>
  );
}

function WebLink({ value }: { value: unknown }) {
  const href = safeHref(value);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {new URL(href).host}
    </a>
  );
}

/**
 * A grid cell: its value, and for a plain value, the way to change it where it
 * is. A tick changes at once; text, a number or an option from a click until
 * Enter, picking, or clicking away. Escape leaves it as it was.
 */
export function GridCell({
  field,
  value,
  people,
  mayEdit,
  onSave,
}: {
  field: Field;
  value: unknown;
  people: People;
  mayEdit: boolean;
  onSave: (value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const edit = mayEdit ? cellEditOf(field) : null;

  if (edit === 'check')
    return (
      <div className={styles.cell}>
        <input
          type="checkbox"
          checked={value === true}
          aria-label={field.label}
          onChange={(e) => onSave(e.target.checked)}
        />
      </div>
    );
  if (!edit || !editing)
    return (
      <div
        className={styles.cell}
        data-editable={edit ? true : undefined}
        data-numeric={edit === 'number' || undefined}
        onClick={() => edit && setEditing(true)}
      >
        <CellValue field={field} value={value} people={people} />
      </div>
    );

  const finish = (next: unknown) => {
    setEditing(false);
    if (next !== value) onSave(next);
  };
  if (edit === 'choice') {
    const choices = choicesOf(field) ?? [];
    return (
      <select
        className={styles.cellInput}
        autoFocus
        aria-label={field.label}
        defaultValue={String(choices.findIndex((c) => c.value === value))}
        onChange={(e) => finish(choices[Number(e.target.value)]?.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
      >
        <option value="-1">No {field.label.toLowerCase()}</option>
        {choices.map((choice, i) => (
          <option key={i} value={i}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  const typed = (text: string): unknown => {
    if (text.trim() === '') return undefined;
    return edit === 'number' ? Number(text) : text;
  };
  return (
    <input
      className={styles.cellInput}
      autoFocus
      aria-label={field.label}
      type={edit === 'number' ? 'number' : 'text'}
      step={field.kind === 'integer' ? 1 : 'any'}
      defaultValue={isBlank(value) ? '' : textOf(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setEditing(false);
      }}
      onBlur={(e) => finish(typed(e.currentTarget.value))}
    />
  );
}
