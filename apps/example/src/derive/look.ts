/** How a collection is looked at: as what, grouped by what, which fields, in what order, filtered how. */
import { isClause, type Clause } from './conditions';
import type { Sort } from './filters';
import { isObject } from './schema-ui';

export const LAYOUTS = ['table', 'board', 'cards'] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_LABELS: Readonly<Record<Layout, string>> = {
  table: 'Table',
  board: 'Board',
  cards: 'Cards',
};
const isLayout = (value: unknown): value is Layout => LAYOUTS.some((layout) => layout === value);

export interface Look {
  readonly layout: Layout;
  /** The choice field a board makes its columns from; the first there is, until one is picked */
  readonly groupBy?: string;
  /** The fields shown, in order; the short ones, until some are picked */
  readonly fields?: ReadonlyArray<string>;
  /** Newest first, until another is picked */
  readonly sort?: Sort;
  readonly filters?: ReadonlyArray<Clause>;
}

export const FIRST_LOOK: Look = { layout: 'table' };

const isSort = (value: unknown): value is Sort =>
  isObject(value) &&
  typeof value.field === 'string' &&
  (value.direction === 'asc' || value.direction === 'desc');

const isNames = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((name) => typeof name === 'string');

/** A look read from anything kept or written by someone else: what is wrong in it is left out */
export function readLook(value: unknown): Look {
  if (!isObject(value)) return FIRST_LOOK;
  const { layout, groupBy, fields, sort, filters } = value;
  return {
    layout: isLayout(layout) ? layout : FIRST_LOOK.layout,
    ...(typeof groupBy === 'string' ? { groupBy } : {}),
    ...(isNames(fields) ? { fields } : {}),
    ...(isSort(sort) ? { sort } : {}),
    ...(Array.isArray(filters) ? { filters: filters.filter(isClause) } : {}),
  };
}
