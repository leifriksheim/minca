import type { JsonSchema, NodeCollection, QueryRecord } from '@minca/core';
import type { Field } from '../../derive/schema-ui';
import type { Column } from './relations';
import type { People } from '../../derive/people';

/** What every layout of a view is handed: the rows it shows, and what it may do with them */
export interface LayoutProps {
  readonly rows: ReadonlyArray<QueryRecord>;
  /** The columns the view shows, in its order */
  readonly fields: ReadonlyArray<Column>;
  readonly schema: JsonSchema | null;
  /** The space's collections, which say how a linked record of any of them is titled */
  readonly collections: ReadonlyArray<NodeCollection>;
  readonly people: People;
  /** Whether the person looking may write in the space at all; each write is still judged by its rules */
  readonly mayEdit: boolean;
  readonly onSave: (record: QueryRecord, field: Field, value: unknown) => void;
  readonly onOpen: (record: QueryRecord) => void;
  /** A new record, with these values and the title typed */
  readonly onAdd: (values: Readonly<Record<string, unknown>>, title: string) => Promise<unknown>;
}
