import { useState } from 'react';
import type { QueryRecord } from '@minca/core';
import { bodyOf, choicesOf, recordLabel, titleField, valueOf, type Field } from '../../derive/schema-ui';
import { CellValue, isBlank, Pill } from './Cell';
import { hueOf } from './fields';
import { NewRow } from './NewRow';
import type { LayoutProps } from './layout';
import styles from './Sheets.module.css';

/** A lane for each option of the field it groups by, and one for the records with none; a card dragged across changes it */
export function Board({ group, ...props }: LayoutProps & { group: Field }) {
  const { rows, mayEdit, onSave, onAdd } = props;
  const [over, setOver] = useState<number | null>(null);
  const options = choicesOf(group) ?? [];
  const lanes = [
    { label: `No ${group.label.toLowerCase()}`, value: undefined },
    ...options.map((option) => ({ label: option.label, value: option.value })),
  ];
  const isIn = (record: QueryRecord, value: unknown) =>
    value === undefined
      ? !options.some((option) => option.value === bodyOf(record)[group.name])
      : bodyOf(record)[group.name] === value;
  const shownLanes = lanes.filter((lane, i) => i > 0 || rows.some((record) => isIn(record, lane.value)));

  return (
    <div className={styles.board}>
      {shownLanes.map((lane, i) => {
        const cards = rows.filter((record) => isIn(record, lane.value));
        return (
          <section
            key={lane.label}
            className={styles.lane}
            aria-label={lane.label}
            data-over={over === i || undefined}
            onDragOver={(e) => {
              if (!mayEdit) return;
              e.preventDefault();
              setOver(i);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const moved = rows.find((record) => record.key === e.dataTransfer.getData('text/plain'));
              if (moved) onSave(moved, group, lane.value);
            }}
          >
            <header>
              {lane.value === undefined ? (
                <span className={styles.muted}>{lane.label}</span>
              ) : (
                <Pill hue={hueOf(group, lane.value)}>{lane.label}</Pill>
              )}
              <small>{cards.length}</small>
            </header>
            {cards.map((record) => (
              <Card key={record.key} record={record} {...props} hide={group.name} draggable={mayEdit} />
            ))}
            {mayEdit && (
              <NewRow
                onAdd={(title) => onAdd(lane.value === undefined ? {} : { [group.name]: lane.value }, title)}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

const DETAILS_ON_A_CARD = 4;

/** A record as a card: its title, then the first few shown fields that hold something */
export function Card({
  record,
  fields,
  schema,
  people,
  onOpen,
  hide,
  draggable = false,
}: Pick<LayoutProps, 'fields' | 'schema' | 'people' | 'onOpen'> & {
  record: QueryRecord;
  /** A field the card leaves out, as a board does the one its lanes say */
  hide?: string;
  draggable?: boolean;
}) {
  const title = titleField(schema);
  const details = fields
    .filter((f) => f.name !== title && f.name !== hide && !isBlank(valueOf(record, f)))
    .slice(0, DETAILS_ON_A_CARD);
  return (
    <button
      type="button"
      className={styles.card}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', record.key)}
      onClick={() => onOpen(record)}
    >
      <strong>{recordLabel(record, schema)}</strong>
      {details.map((field) => (
        <span key={field.name} className={styles.detail}>
          <CellValue field={field} value={valueOf(record, field)} people={people} />
        </span>
      ))}
    </button>
  );
}
