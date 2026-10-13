/**
 * A locked-down SQLite for contracts: one read-only `SELECT`, over tables the
 * host fills, in a fresh in-memory database per evaluation.
 *
 * - `sqlite3_set_authorizer` allows only `SELECT`, reads of the host's tables
 *   (and `json_each`/`json_tree`), `WITH RECURSIVE`, and the functions in
 *   `FUNCTIONS`; everything else is refused when the query is prepared.
 * - `sqlite3_progress_handler` counts virtual machine steps and stops the
 *   query past a limit.
 * - `sqlite3_limit` bounds the query's length, depth and values.
 *
 * The official build (`@sqlite.org/sqlite-wasm`) runs in Node and browsers
 * alike and exposes the C API. `node:sqlite` has `setAuthorizer` but no
 * progress handler (Node 24), so it can't bound a query.
 */
import init from '@sqlite.org/sqlite-wasm';

type Sqlite3 = Awaited<ReturnType<typeof init>>;
type SqlValue = string | number | bigint | null;

/** A table the host fills: its columns, and rows of values in that order */
export interface Table {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<SqlValue>>;
}

export type Outcome =
  | { readonly passed: boolean; readonly steps: number }
  | { readonly refused: string }
  | { readonly limit: 'steps'; readonly steps: number }
  | { readonly error: string };

/** Deterministic functions a contract may call. Left out: clocks, randomness, connection state, float printing, order-dependent aggregates, libm. */
const FUNCTIONS: ReadonlySet<string> = new Set([
  // core scalars
  'abs',
  'coalesce',
  'ifnull',
  'iif',
  'if',
  'instr',
  'length',
  'octet_length',
  'lower',
  'upper',
  'ltrim',
  'rtrim',
  'trim',
  'max',
  'min',
  'nullif',
  'substr',
  'substring',
  'replace',
  'round',
  'sign',
  'typeof',
  'unicode',
  'char',
  'hex',
  'like',
  'glob',
  'concat',
  'concat_ws',
  // aggregates whose result doesn't depend on row order
  'count',
  'sum',
  'total',
  'avg',
  // JSON
  '->',
  '->>',
  'json',
  'json_extract',
  'json_array_length',
  'json_type',
  'json_valid',
  'json_quote',
  'json_array',
  'json_object',
]);

/** Tables a contract may read besides the host's */
const TABLE_FUNCTIONS: ReadonlySet<string> = new Set(['json_each', 'json_tree']);

const MAX_STEPS = 100_000;

export interface Engine {
  readonly sqlite3: Sqlite3;
  readonly version: string;
  /**
   * Runs each condition in order over one fresh database of `tables`; passes
   * when each gives exactly one row of one column equal to integer 1. Steps
   * are counted across them all.
   */
  evaluate(
    conditions: string | ReadonlyArray<string>,
    tables: Readonly<Record<string, Table>>,
    options?: { readonly maxSteps?: number },
  ): Outcome;
  /** For probes: every row, unauthorized and unlimited apart from the authorizer */
  rows(sql: string, tables?: Readonly<Record<string, Table>>): SqlValue[][];
}

let loaded: Promise<Engine> | undefined;

/** The engine on the bundled SQLite, loaded once */
export const loadEngine = (): Promise<Engine> => (loaded ??= init().then(engineOn));

/** An engine on one build of sqlite-wasm: pass another build to compare versions */
function engineOn(sqlite3: Sqlite3): Engine {
  const { capi, oo1 } = sqlite3;

  function open(tables: Readonly<Record<string, Table>>) {
    const db = new oo1.DB(':memory:');
    const p = db.pointer;
    if (p === undefined) throw new Error('no database');
    capi.sqlite3_db_config(p, capi.SQLITE_DBCONFIG_DEFENSIVE, 1);
    capi.sqlite3_db_config(p, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, 0);
    capi.sqlite3_db_config(p, capi.SQLITE_DBCONFIG_ENABLE_VIEW, 0);
    capi.sqlite3_db_config(p, capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0);
    for (const [name, t] of Object.entries(tables)) {
      db.exec(`CREATE TABLE ${ident(name)} (${t.columns.map(ident).join(', ')})`);
      const insert = db.prepare(`INSERT INTO ${ident(name)} VALUES (${t.columns.map(() => '?').join(', ')})`);
      for (const row of t.rows) insert.bind([...row]).stepReset();
      insert.finalize();
    }
    return { db, p };
  }

  function evaluate(
    conditions: string | ReadonlyArray<string>,
    tables: Readonly<Record<string, Table>>,
    options: { readonly maxSteps?: number } = {},
  ): Outcome {
    const max = options.maxSteps ?? MAX_STEPS;
    const { db, p } = open(tables);
    try {
      capi.sqlite3_limit(p, capi.SQLITE_LIMIT_SQL_LENGTH, 4000);
      capi.sqlite3_limit(p, capi.SQLITE_LIMIT_EXPR_DEPTH, 64);
      capi.sqlite3_limit(p, capi.SQLITE_LIMIT_LENGTH, 1_000_000);
      capi.sqlite3_limit(p, capi.SQLITE_LIMIT_COMPOUND_SELECT, 16);
      capi.sqlite3_limit(p, capi.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 200);
      let why = '';
      const allowed = new Set(Object.keys(tables));
      capi.sqlite3_set_authorizer(
        p,
        (_arg, code, a1, a2) => {
          if (code === capi.SQLITE_SELECT || code === capi.SQLITE_RECURSIVE) return capi.SQLITE_OK;
          if (
            code === capi.SQLITE_READ &&
            typeof a1 === 'string' &&
            (allowed.has(a1) || TABLE_FUNCTIONS.has(a1))
          )
            return capi.SQLITE_OK;
          if (code === capi.SQLITE_FUNCTION && typeof a2 === 'string' && FUNCTIONS.has(a2.toLowerCase()))
            return capi.SQLITE_OK;
          why ||= `not allowed: action ${code} ${String(a1)} ${String(a2)}`;
          return capi.SQLITE_DENY;
        },
        0,
      );
      let steps = 0;
      let over = false;
      capi.sqlite3_progress_handler(
        p,
        1,
        () => {
          steps += 1;
          if (steps > max) over = true;
          return over ? 1 : 0;
        },
        0,
      );
      for (const sql of typeof conditions === 'string' ? [conditions] : conditions) {
        let value: SqlValue | undefined;
        try {
          const stmt = db.prepare(sql);
          try {
            if (stmt.columnCount !== 1) return { refused: 'a contract gives one column' };
            let n = 0;
            while (stmt.step()) {
              n += 1;
              value = n === 1 ? sqlValue(stmt.get(0)) : undefined;
            }
          } finally {
            stmt.finalize();
          }
        } catch (e) {
          if (over) return { limit: 'steps', steps };
          if (why) return { refused: why };
          return { error: e instanceof Error ? e.message : String(e) };
        }
        if (value !== 1 && value !== 1n) return { passed: false, steps };
      }
      return { passed: true, steps };
    } finally {
      db.close();
    }
  }

  function rows(sql: string, tables: Readonly<Record<string, Table>> = {}): SqlValue[][] {
    const { db } = open(tables);
    try {
      const out: SqlValue[][] = [];
      db.exec({
        sql,
        rowMode: 'array',
        callback: (row: unknown) => {
          if (Array.isArray(row)) out.push(row.map(sqlValue));
        },
      });
      return out;
    } finally {
      db.close();
    }
  }

  return { sqlite3, version: capi.sqlite3_libversion(), evaluate, rows };
}

function sqlValue(x: unknown): SqlValue {
  if (x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'bigint') return x;
  return JSON.stringify(x) ?? null;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad name ${name}`);
  return `"${name}"`;
}
