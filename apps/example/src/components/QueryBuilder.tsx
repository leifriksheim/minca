import type { Query } from '@minca/core';
import type { Clause, ClauseField } from '../derive/conditions';
import type { Sort } from '../derive/filters';
import type { People } from '../derive/people';
import { ClauseList } from './automations/parts';
import styles from './QueryBuilder.module.css';

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** Filters, order and page size for one collection, picked from its schema; the query they make shown underneath */
export function QueryBuilder({
  fields,
  clauses,
  onClauses,
  sort,
  onSort,
  pageSize,
  onPageSize,
  people,
  me,
  query,
}: {
  fields: ReadonlyArray<ClauseField>;
  clauses: ReadonlyArray<Clause>;
  onClauses: (next: ReadonlyArray<Clause>) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  pageSize: number;
  onPageSize: (next: number) => void;
  people: People;
  me: string | null;
  query: Query;
}) {
  // Record times first, then the fields that compare simply.
  const sortable = [
    ...fields.filter((f) => f.name.startsWith('@') && f.kind === 'date'),
    ...fields.filter(
      (f) => !f.name.startsWith('@') && ['search', 'number', 'yesno', 'choice'].includes(f.kind),
    ),
  ];

  return (
    <div className="stack">
      <div className="row">
        <div className={styles.clauses}>
          <ClauseList
            fields={fields}
            clauses={clauses}
            onChange={onClauses}
            people={people}
            me={me}
            suggest={false}
            add="+ Filter"
          />
        </div>
        {clauses.length > 0 && (
          <button data-intent="quiet" onClick={() => onClauses([])}>
            Clear filters
          </button>
        )}
        <label className="row">
          Sort by
          <select value={sort.field} onChange={(e) => onSort({ ...sort, field: e.target.value })}>
            {sortable.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={sort.direction}
            onChange={(e) => onSort({ ...sort, direction: e.target.value === 'asc' ? 'asc' : 'desc' })}
            aria-label="Direction"
          >
            <option value="desc">{directionLabel(sortable, sort.field, 'desc')}</option>
            <option value="asc">{directionLabel(sortable, sort.field, 'asc')}</option>
          </select>
        </label>
        <label className="row">
          Per page
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details>
        <summary>
          <small>As a query</small>
        </summary>
        <pre>{JSON.stringify(query, null, 2)}</pre>
      </details>
    </div>
  );
}

/** "Newest first" for times, "A → Z" for text, "Low → high" for numbers */
function directionLabel(fields: ReadonlyArray<ClauseField>, name: string, direction: 'asc' | 'desc'): string {
  const kind = fields.find((f) => f.name === name)?.kind;
  const asc = direction === 'asc';
  switch (kind) {
    case 'date':
      return asc ? 'Oldest first' : 'Newest first';
    case 'search':
      return asc ? 'A → Z' : 'Z → A';
    case 'yesno':
      return asc ? 'No first' : 'Yes first';
    default:
      return asc ? 'Low → high' : 'High → low';
  }
}
