/**
 * @module sqlite-adapter
 * A node's stores in one SQLite database: every store's entries and version
 * bodies, each store a path, every write one transaction.
 *
 * The connection is passed in, so this module never imports a driver and runs
 * wherever one does: Node's `node:sqlite` (`DatabaseSync`), Bun's `bun:sqlite`
 * (`Database`), or another with the same four methods.
 *
 * ```
 * stores    (id, path)               one row per store a node opened
 * entries   (store, key, value)      which version is current, what sync compares, space records
 * versions  (store, id, body)        version bodies, as UTF-8 JSON
 * ```
 *
 * One process writes the database. Unlike a directory store it keeps nothing
 * in memory between calls, so there is nothing to reload and nothing polls it.
 */

import type { StorageAdapter, BatchOp, Version } from '../types.js';
import type { StoreFactory, StoreOptions } from '../node/stores.js';
import { isStoredVersion } from '../utils/guards.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { createEncryptedAdapter } from './encrypted-adapter.js';
import { createBodyCache } from './body-cache.js';

/** A value SQLite binds or returns here */
export type SqliteValue = string | number | bigint | Uint8Array | null;

/** One prepared statement, as Node's `StatementSync` and Bun's `Statement` both give */
export interface SqliteStatement {
  run(...params: SqliteValue[]): unknown;
  /** The first row, or undefined (Node) or null (Bun) for none */
  get(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
}

/** The slice of a SQLite connection the stores use */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/**
 * Version bodies all the spaces' stores keep in memory together. Reading one
 * from SQLite is cheap, so this is for the few read again and again, and the
 * bodies a node keeps in memory stay the same however many spaces it holds.
 */
const CACHED_BODIES = 4_000;

/** Bytes per page: SQLite reads large values fastest at 8 or 16 KiB, and file chunks are 256 KiB */
const PAGE_SIZE = 8192;

/** Before any table: page size and auto-vacuum are fixed once the file has one */
const SCHEMA = `
PRAGMA page_size = ${PAGE_SIZE};
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS stores (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS entries (
  store INTEGER NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (store, key));
CREATE TABLE IF NOT EXISTS versions (
  store INTEGER NOT NULL, id TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY (store, id));
`;

/** A node's stores in one database, and what they take */
export type SqliteStores = StoreFactory & {
  /** What a store keeps, in bytes: its keys, values and version bodies */
  size(path: string): number;
  /** Every store path that holds anything */
  paths(): string[];
};

/**
 * A node's stores in one SQLite database, for a node on a server or a
 * computer. Opening a store again gives the same data; closing one leaves the
 * database open, since the others share it: close the connection yourself
 * when the node is done.
 * @param options.localKey Seals the registry. Without it nothing is sealed.
 */
export function sqliteStores(
  db: SqliteDatabase,
  options: { readonly localKey?: CryptoKey | null } = {},
): SqliteStores {
  db.exec(SCHEMA);
  const sql = {
    findStore: db.prepare('SELECT id FROM stores WHERE path = ?'),
    addStore: db.prepare('INSERT OR IGNORE INTO stores (path) VALUES (?)'),
    paths: db.prepare(
      `SELECT path FROM stores s WHERE EXISTS (SELECT 1 FROM entries WHERE store = s.id)
         OR EXISTS (SELECT 1 FROM versions WHERE store = s.id) ORDER BY path`,
    ),
    get: db.prepare('SELECT value FROM entries WHERE store = ? AND key = ?'),
    put: db.prepare(
      'INSERT INTO entries (store, key, value) VALUES (?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value',
    ),
    delete: db.prepare('DELETE FROM entries WHERE store = ? AND key = ?'),
    keysFrom: db.prepare('SELECT key FROM entries WHERE store = ? AND key >= ? ORDER BY key'),
    keysBetween: db.prepare('SELECT key FROM entries WHERE store = ? AND key >= ? AND key < ? ORDER BY key'),
    entriesFrom: db.prepare('SELECT key, value FROM entries WHERE store = ? AND key >= ? ORDER BY key'),
    entriesBetween: db.prepare(
      'SELECT key, value FROM entries WHERE store = ? AND key >= ? AND key < ? ORDER BY key',
    ),
    getVersion: db.prepare('SELECT body FROM versions WHERE store = ? AND id = ?'),
    putVersion: db.prepare(
      'INSERT INTO versions (store, id, body) VALUES (?, ?, ?) ON CONFLICT (store, id) DO UPDATE SET body = excluded.body',
    ),
    deleteVersion: db.prepare('DELETE FROM versions WHERE store = ? AND id = ?'),
    entryBytes: db.prepare(
      'SELECT coalesce(sum(length(CAST(key AS BLOB)) + length(value)), 0) AS n FROM entries WHERE store = ?',
    ),
    // A blob's length is in its row's header: nothing is read to sum them.
    versionBytes: db.prepare('SELECT coalesce(sum(length(body)), 0) AS n FROM versions WHERE store = ?'),
  };

  const storeId = (path: string): number | null => {
    const row = sql.findStore.get(path);
    return isRow(row) && typeof row.id === 'number' ? row.id : null;
  };

  /** Runs `work` in one transaction: all of it lands, or none */
  const inTransaction = (work: () => void): void => {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const open = (path: string): StorageAdapter => {
    sql.addStore.run(path);
    const id = storeId(path)!;
    let closed = false;
    const live = () => {
      if (closed) throw new Error(`The store ${path} is closed`);
      return id;
    };

    const putVersion = (version: Version) =>
      void sql.putVersion.run(live(), version.id, utf8Encode(JSON.stringify(version)));
    const put = (key: string, value: Uint8Array) => void sql.put.run(live(), checkKey(key), value);
    const apply = (ops: ReadonlyArray<BatchOp>) => {
      for (const op of ops) {
        if (op.type === 'put') put(op.key, op.value);
        else sql.delete.run(live(), op.key);
      }
    };
    const readVersion = (versionId: string): Version | null => {
      const row = sql.getVersion.get(live(), versionId);
      return isRow(row) && row.body instanceof Uint8Array ? parseVersion(row.body) : null;
    };

    return Object.freeze({
      async get(key: string): Promise<Uint8Array | null> {
        const row = sql.get.get(live(), key);
        return isRow(row) && row.value instanceof Uint8Array ? row.value : null;
      },
      async put(key: string, value: Uint8Array): Promise<void> {
        put(key, value);
      },
      async delete(key: string): Promise<void> {
        sql.delete.run(live(), key);
      },
      async list(prefix = ''): Promise<string[]> {
        const end = after(prefix);
        const rows =
          end === null ? sql.keysFrom.all(live(), prefix) : sql.keysBetween.all(live(), prefix, end);
        return rows.flatMap((row) => (isRow(row) && typeof row.key === 'string' ? [row.key] : []));
      },
      async entries(prefix: string): Promise<ReadonlyArray<readonly [string, Uint8Array]>> {
        const end = after(prefix);
        const rows =
          end === null ? sql.entriesFrom.all(live(), prefix) : sql.entriesBetween.all(live(), prefix, end);
        return rows.flatMap((row) =>
          isRow(row) && typeof row.key === 'string' && row.value instanceof Uint8Array
            ? [[row.key, row.value] as const]
            : [],
        );
      },
      async putVersion(version: Version): Promise<void> {
        putVersion(version);
      },
      async getVersion(versionId: string): Promise<Version | null> {
        return readVersion(versionId);
      },
      async getVersions(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Version | null>> {
        return ids.map(readVersion);
      },
      async deleteVersion(versionId: string): Promise<void> {
        sql.deleteVersion.run(live(), versionId);
      },
      async batch(ops: ReadonlyArray<BatchOp>): Promise<void> {
        inTransaction(() => apply(ops));
      },
      async commit(write: {
        readonly store: ReadonlyArray<Version>;
        readonly ops: ReadonlyArray<BatchOp>;
        readonly remove: ReadonlyArray<string>;
      }): Promise<void> {
        inTransaction(() => {
          for (const version of write.store) putVersion(version);
          apply(write.ops);
          for (const versionId of write.remove) sql.deleteVersion.run(live(), versionId);
        });
      },
      async close(): Promise<void> {
        closed = true;
      },
    } satisfies StorageAdapter);
  };

  const count = (row: unknown): number => (isRow(row) ? Number(row.n ?? 0) : 0);

  const factory = async (path: string, storeOptions?: StoreOptions): Promise<StorageAdapter> => {
    const adapter = open(path);
    return storeOptions?.seal && options.localKey
      ? createEncryptedAdapter(adapter, options.localKey)
      : adapter;
  };

  return Object.assign(factory, {
    cache: createBodyCache(CACHED_BODIES),
    size(path: string): number {
      const id = storeId(path);
      return id === null ? 0 : count(sql.entryBytes.get(id)) + count(sql.versionBytes.get(id));
    },
    paths(): string[] {
      return sql.paths.all().flatMap((row) => (isRow(row) && typeof row.path === 'string' ? [row.path] : []));
    },
  });
}

/**
 * The first string after every string starting with `prefix`, or null when
 * there is none. SQLite compares text as UTF-8 bytes, which sort as code
 * points do, so `[prefix, after(prefix))` is exactly the strings it starts.
 */
export function after(prefix: string): string | null {
  const points = [...prefix];
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last >= 0x10ffff) continue;
    // A surrogate is no code point of its own: the next one after them is U+E000.
    const next = last + 1 >= 0xd800 && last + 1 <= 0xdfff ? 0xe000 : last + 1;
    return points.join('') + String.fromCodePoint(next);
  }
  return null;
}

/** A key as SQLite keeps it whole: text read back stops at U+0000 */
function checkKey(key: string): string {
  if (key.includes('\0')) throw new Error('A store key may not hold U+0000');
  return key;
}

function parseVersion(body: Uint8Array): Version | null {
  try {
    const value: unknown = JSON.parse(utf8Decode(body));
    return isStoredVersion(value) ? value : null;
  } catch {
    return null;
  }
}

const isRow = (row: unknown): row is Record<string, unknown> => typeof row === 'object' && row !== null;
