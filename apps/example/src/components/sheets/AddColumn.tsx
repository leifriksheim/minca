import { useState } from 'react';
import type { NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Icon } from '@minca/app-shared/Icon';
import { FIELD_TYPE_INFO, isFieldType, type FieldTypeName } from '../../derive/field-types';
import { usePopover } from '../usePopover';
import { Panel } from './Popover';
import { addColumn } from './tables';
import styles from './Sheets.module.css';

/** The types a column can be made as, the everyday ones first */
const COLUMN_TYPES: ReadonlyArray<FieldTypeName> = [
  'text',
  'long text',
  'number',
  'choice',
  'yes/no',
  'date',
  'person',
  'people',
  'web link',
  'money',
  'file',
  'picture',
];

/** "+" at the end of a table's head: a new column, named and typed, for everyone */
export function AddColumn({ space, collection }: { space: SpaceSummary; collection: NodeCollection }) {
  const node = useNode();
  const { open, setOpen, close, root } = usePopover();
  const [type, setType] = useState<FieldTypeName>('text');
  const { run, busy, error, setError } = useAction();

  return (
    <div ref={root} className={styles.popoverAnchor}>
      <button
        className={styles.tool}
        onClick={() => setOpen((was) => !was)}
        aria-label="Add a column"
        aria-expanded={open}
      >
        <Icon name="plus" size={14} />
      </button>
      {open && (
        <Panel anchor={root} align="end">
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              const label = textIn(values, 'label');
              const options = textIn(values, 'options')
                .split(',')
                .map((option) => option.trim())
                .filter(Boolean);
              if (!label) return setError('Give the column a name');
              if (type === 'choice' && options.length === 0)
                return setError('Give it some options to pick from');
              void run(async () => {
                await addColumn(node, space.id, collection, label, type, options);
                close();
              });
            }}
          >
            <input
              name="label"
              placeholder="Column name"
              aria-label="Column name"
              autoFocus
              maxLength={100}
            />
            <select
              aria-label="Type"
              value={type}
              onChange={(e) => isFieldType(e.target.value) && setType(e.target.value)}
            >
              {COLUMN_TYPES.map((name) => (
                <option key={name} value={name}>
                  {FIELD_TYPE_INFO[name].mark} {name[0]?.toUpperCase()}
                  {name.slice(1)}
                </option>
              ))}
            </select>
            {type === 'choice' && (
              <input name="options" placeholder="Options, split by commas" aria-label="Options" />
            )}
            {error && <p role="alert">{error}</p>}
            <button type="submit" data-intent="primary" disabled={busy}>
              Add column
            </button>
          </form>
        </Panel>
      )}
    </div>
  );
}

/** What was typed into a form's field, trimmed; nothing for a field it doesn't have */
function textIn(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === 'string' ? value.trim() : '';
}
