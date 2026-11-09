import { useAccount } from '@minca/react';
import { clauseFields, type Clause } from '../../derive/conditions';
import { NEWEST_FIRST } from '../../derive/filters';
import { isComputed, withComputed, type Field } from '../../derive/schema-ui';
import type { People } from '../../derive/people';
import type { Look } from '../../derive/look';
import { ClauseList } from '../automations/parts';
import { cellEditOf, fieldMark } from './fields';
import { Popover } from './Popover';
import styles from './Sheets.module.css';

/** What a view's toolbar changes: which fields, which records, in what order, and on a board, by what */
export function Toolbar({
  look,
  onLook,
  all,
  shown,
  groupable,
  schema,
  people,
}: {
  look: Look;
  onLook: (look: Look) => void;
  /** Every field the table has */
  all: ReadonlyArray<Field>;
  shown: ReadonlyArray<Field>;
  groupable: ReadonlyArray<Field>;
  schema: Parameters<typeof withComputed>[0];
  people: People;
}) {
  const { did } = useAccount();
  const filters = look.filters ?? [];
  const sort = look.sort ?? NEWEST_FIRST;
  const filterable = clauseFields(
    { schema: withComputed(schema, all.filter(isComputed)), topics: [] },
    { query: true },
  );
  const sortable = [...ORDERS_BY_TIME, ...all.filter((f) => cellEditOf(f) !== null || f.kind === 'number')];
  const isShown = (field: Field) => shown.some((f) => f.name === field.name);

  return (
    <div className={styles.toolbar}>
      {look.layout === 'board' && groupable.length > 1 && (
        <Popover icon="board" label="Group">
          {(close) => (
            <div className={styles.choices}>
              {groupable.map((field) => (
                <button
                  key={field.name}
                  data-selected={field.name === (look.groupBy ?? groupable[0]?.name) || undefined}
                  onClick={() => {
                    close();
                    onLook({ ...look, groupBy: field.name });
                  }}
                >
                  {field.label}
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
      <Popover
        icon="filter"
        label={filters.length ? `Filtered by ${filters.length}` : 'Filter'}
        active={filters.length > 0}
      >
        {() => (
          <ClauseList
            fields={filterable}
            clauses={filters}
            onChange={(next: ReadonlyArray<Clause>) => onLook({ ...look, filters: next })}
            people={people}
            me={did}
            suggest={false}
            empty="Every record shows."
            add="+ Add a filter"
          />
        )}
      </Popover>
      <Popover icon="sort" label="Sort" active={look.sort !== undefined}>
        {() => (
          <div className={styles.form}>
            <select
              aria-label="Sort by"
              value={sort.field}
              onChange={(e) => onLook({ ...look, sort: { ...sort, field: e.target.value } })}
            >
              {sortable.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Direction"
              value={sort.direction}
              onChange={(e) =>
                onLook({ ...look, sort: { ...sort, direction: e.target.value === 'asc' ? 'asc' : 'desc' } })
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
        )}
      </Popover>
      <Popover icon="layers" label="Fields">
        {() => (
          <div className={styles.choices}>
            {all.map((field) => (
              <label key={field.name}>
                <input
                  type="checkbox"
                  checked={isShown(field)}
                  onChange={(e) =>
                    onLook({
                      ...look,
                      fields: all
                        .filter((f) => (f.name === field.name ? e.target.checked : isShown(f)))
                        .map((f) => f.name),
                    })
                  }
                />
                <span className={styles.mark} aria-hidden>
                  {fieldMark(field, schema)}
                </span>
                {field.label}
              </label>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** The record's own times, which every table can be put in order by */
const ORDERS_BY_TIME = [
  { name: '@createdAt', label: 'Date added' },
  { name: '@updatedAt', label: 'Last changed' },
] as const;
