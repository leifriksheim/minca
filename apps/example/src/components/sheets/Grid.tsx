import type { ReactNode } from 'react';
import { Icon } from '@minca/app-shared/Icon';
import { recordLabel, valueOf } from '../../derive/schema-ui';
import { GridCell } from './Cell';
import { fieldMark } from './fields';
import { NewRow } from './NewRow';
import { RelationCell } from './RelationCell';
import type { LayoutProps } from './layout';
import styles from './Sheets.module.css';

/** The records as rows and the shown fields as columns, a plain value changed in its cell */
export function Grid({
  spaceId,
  rows,
  fields,
  schema,
  collections,
  people,
  mayEdit,
  onSave,
  onRelink,
  onOpen,
  onAdd,
  addColumn,
}: LayoutProps & { addColumn: ReactNode }) {
  return (
    <div className={styles.gridScroll}>
      <table className={styles.grid}>
        <thead>
          <tr>
            {fields.map((field) => (
              <th key={field.name} scope="col">
                <span className={styles.mark} aria-hidden>
                  {fieldMark(field, schema)}
                </span>
                {field.label}
              </th>
            ))}
            <th className={styles.addColumn}>{addColumn}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((record) => (
            <tr key={record.key}>
              {fields.map((field, i) => (
                <td key={field.name}>
                  {i === 0 && (
                    <button
                      className={styles.open}
                      onClick={() => onOpen(record)}
                      aria-label={`Open ${recordLabel(record, schema)}`}
                    >
                      <Icon name="expand" size={14} />
                    </button>
                  )}
                  {field.related ? (
                    <RelationCell
                      spaceId={spaceId}
                      record={record}
                      column={field}
                      collections={collections}
                      mayEdit={mayEdit}
                      onOpen={onOpen}
                      onRelink={onRelink}
                    />
                  ) : (
                    <GridCell
                      field={field}
                      value={valueOf(record, field)}
                      people={people}
                      mayEdit={mayEdit}
                      onSave={(value) => onSave(record, field, value)}
                    />
                  )}
                </td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      {mayEdit && <NewRow onAdd={(title) => onAdd({}, title)} />}
    </div>
  );
}
