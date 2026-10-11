/**
 * @module account-store
 * The accounts that live somewhere — in a folder, or in this browser.
 *
 * A folder is a disk, not a person. Several people can keep accounts in one, and
 * one person can keep several: work and personal, or a spare for testing. So the
 * folder holds a list of who has an account in it, and a subtree per account.
 *
 * ```
 * <folder>/
 *   accounts.json                  name, DID and id of each account
 *   accounts/<id>/account.json     that account's keys, locked
 *   accounts/<id>/stores/...       that account's spaces
 * ```
 *
 * **The list is readable without unlocking anything**, which it has to be — you
 * cannot offer someone a choice of accounts without knowing their names. So
 * whoever holds the folder can see how many accounts are in it and what they
 * are called. What they cannot do is open one.
 *
 * A browser with no folder keeps the same shape in IndexedDB, so the app above
 * has one model rather than two.
 */

import type { DirectoryHandleLike } from '../storage/folder-adapter.js';
import { readFolderFile, writeFolderFile } from '../storage/folder-adapter.js';
import { isAccountVault, type AccountVault } from './account-vault.js';
import { base64UrlEncode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';
import { isRecord } from '../utils/guards.js';
import { idbRun, openDb } from './idb.js';

/** What can be known about an account without unlocking it */
export interface AccountSummary {
  /** Stable, random, and the name of this account's subtree */
  readonly id: string;
  /** What the person called it. A label — never part of any key. */
  readonly name: string;
  readonly did: string;
  readonly createdAt: string;
  /**
   * Where this account's spaces live, relative to the store root.
   *
   * Carried rather than computed so that a row filed again under a fresh id
   * keeps pointing at the subtree its data already lives in.
   */
  readonly dataPath: string;
  readonly lastUsedAt?: string;
}

export interface AccountStore {
  readonly kind: 'folder' | 'browser';
  /**
   * Every account here, most recently used first.
   *
   * At most one entry per identity. Two rows for one DID is always a mistake —
   * they would appear as separate accounts in a picker while being the same
   * person — so a duplicate is collapsed onto the most recently used.
   */
  list(): Promise<ReadonlyArray<AccountSummary>>;
  /** One account's locked keys */
  read(id: string): Promise<AccountVault | null>;
  /** Adds or replaces an account */
  write(summary: AccountSummary, vault: AccountVault): Promise<void>;
  /** Forgets an account, and everything it owns */
  remove(id: string): Promise<void>;
}

const LIST_FILE = 'accounts.json';
const ACCOUNTS_DIR = 'accounts';
const VAULT_FILE = 'account.json';

/** Where a brand new account keeps its spaces. */
export function accountDataPath(id: string): string {
  return `${ACCOUNTS_DIR}/${id}/stores`;
}

/** A short, stable, filename-safe id for a new account. */
export function newAccountId(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(8)))
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 12);
}

/**
 * Whether an id has the shape {@link newAccountId} gives one.
 *
 * An id names a directory, and `remove` deletes that directory with everything
 * in it. The list it comes from is a plain file in a folder that may be synced
 * or shared, so an id is checked before it is trusted with a path.
 */
export function isAccountId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{1,12}$/.test(id);
}

/**
 * Whether a row points somewhere this store could have put it.
 *
 * `dataPath` is carried, not computed, but there is only one shape it can
 * honestly have: an account subtree. Usually the subtree is the row's own —
 * though a row filed again under a fresh id keeps the one its data already
 * lives in. Anything else, `../../elsewhere` above all, is someone editing the
 * list to aim an account at files outside the folder.
 */
function isTrustworthy(account: unknown): boolean {
  if (!isRecord(account) || !isAccountId(account.id) || typeof account.dataPath !== 'string') return false;
  const [accounts, id, stores, ...more] = account.dataPath.split('/');
  return accounts === ACCOUNTS_DIR && isAccountId(id) && stores === 'stores' && more.length === 0;
}

/** A row read back from the list; the fields beyond id and path are taken as written. */
function isTrustworthyRow(row: unknown): row is AccountSummary {
  return isTrustworthy(row);
}

function checkId(id: string): void {
  if (!isAccountId(id)) throw new TypeError(`Not an account id: ${JSON.stringify(id)}`);
}

/** Most recently used first, so the picker opens on the likely one. */
function byRecency(a: AccountSummary, b: AccountSummary): number {
  return (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt);
}

/**
 * Most recently used first, one row per identity.
 *
 * A summary is a label on an identity, so two of them for one DID means the
 * same person listed twice — which is confusing at best and, once they point
 * at different data paths, a way to lose track of where anything is.
 */
function collapse(accounts: ReadonlyArray<AccountSummary>): AccountSummary[] {
  const seen = new Set<string>();
  return [...accounts].sort(byRecency).filter((account) => {
    if (seen.has(account.did)) return false;
    seen.add(account.did);
    return true;
  });
}

function parseList(bytes: Uint8Array | null): AccountSummary[] {
  if (!bytes) return [];
  try {
    const parsed: unknown = JSON.parse(utf8Decode(bytes));
    // A row that fails the check is skipped, not repaired: it was not written
    // by this store, so there is no telling what it was meant to be.
    return isRecord(parsed) && Array.isArray(parsed.accounts) ? parsed.accounts.filter(isTrustworthyRow) : [];
  } catch {
    throw protocolError(
      'FOLDER_ACCOUNT_UNREADABLE',
      `${LIST_FILE} in that folder is not valid JSON.`,
      'Move it aside and sign in with your code to write a fresh one — no account ' +
        'data is lost, only the list of which accounts exist.',
    );
  }
}

/** Opens the accounts kept in a folder. */
export function createFolderAccountStore(dir: DirectoryHandleLike): AccountStore {
  async function readList(): Promise<AccountSummary[]> {
    return parseList(await readFolderFile(dir, LIST_FILE));
  }

  async function writeList(accounts: ReadonlyArray<AccountSummary>): Promise<void> {
    await writeFolderFile(
      dir,
      LIST_FILE,
      utf8Encode(`${JSON.stringify({ version: 1, accounts }, null, 2)}\n`),
    );
  }

  /** The directory holding one account's keys. */
  async function accountDir(id: string, create: boolean): Promise<DirectoryHandleLike | null> {
    try {
      const accounts = await dir.getDirectoryHandle(ACCOUNTS_DIR, { create });
      return await accounts.getDirectoryHandle(id, { create });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  return Object.freeze({
    kind: 'folder' as const,

    async list(): Promise<ReadonlyArray<AccountSummary>> {
      return collapse(await readList());
    },

    async read(id: string): Promise<AccountVault | null> {
      if (!isAccountId(id)) return null;
      const home = await accountDir(id, false);
      if (!home) return null;

      const bytes = await readFolderFile(home, VAULT_FILE);
      if (!bytes) return null;

      try {
        const vault: unknown = JSON.parse(utf8Decode(bytes));
        if (!isAccountVault(vault)) throw new Error('not a vault');
        return vault;
      } catch {
        throw protocolError(
          'FOLDER_ACCOUNT_UNREADABLE',
          `The keys for that account could not be read.`,
          'The file may have been edited by hand. Sign in with your code to write a new one.',
        );
      }
    },

    async write(summary: AccountSummary, vault: AccountVault): Promise<void> {
      if (!isTrustworthy(summary)) {
        throw new TypeError(`Account ${JSON.stringify(summary.id)} does not have a valid id and data path`);
      }
      const home = await accountDir(summary.id, true);
      // Only the folder itself being gone makes creating inside it fail this way.
      if (!home)
        throw protocolError(
          'FOLDER_GONE',
          'Your pod folder could not be found.',
          'It may have been moved, renamed or deleted. Choose it again, or keep this account in the browser instead.',
        );

      await writeFolderFile(home, VAULT_FILE, utf8Encode(`${JSON.stringify(vault, null, 2)}\n`));

      // Drops any row for the same identity as well as the same id: the caller
      // has just said which account this is.
      const accounts = (await readList()).filter(
        (account) => account.id !== summary.id && account.did !== summary.did,
      );
      await writeList([...accounts, summary]);
    },

    async remove(id: string): Promise<void> {
      checkId(id);
      await writeList((await readList()).filter((account) => account.id !== id));

      try {
        const accounts = await dir.getDirectoryHandle(ACCOUNTS_DIR);
        await accounts.removeEntry(id, { recursive: true });
      } catch (error) {
        // Already gone, or the browser will not recurse. The list no longer
        // mentions it either way.
        if (!(error instanceof Error) || error.name !== 'NotFoundError') throw error;
      }
    },
  });
}

// ─── Accounts kept in this browser ─────────────────────────────────────

const DB_NAME = 'weave-accounts';
const STORE = 'accounts';
const LIST_KEY = '__list';

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return idbRun(db, STORE, 'readonly', (store) => store.get(key));
}

/** The list as this store wrote it; unlike a folder's, no other origin can edit it */
async function idbList(db: IDBDatabase): Promise<AccountSummary[]> {
  const rows = await idbGet(db, LIST_KEY);
  return isSummaryList(rows) ? rows : [];
}

function isSummaryList(rows: unknown): rows is AccountSummary[] {
  return Array.isArray(rows);
}

async function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  await idbRun(db, STORE, 'readwrite', (store) => store.put(value, key));
}

/**
 * Opens the accounts kept in this browser, for when there is no folder.
 *
 * Same shape as a folder store, so nothing above has to know which it got —
 * the difference is only that no other origin can read this one.
 *
 * @param dbName Overridable for tests
 */
export async function createBrowserAccountStore(dbName = DB_NAME): Promise<AccountStore> {
  const db = await openDb(dbName, STORE);

  return Object.freeze({
    kind: 'browser' as const,

    async list(): Promise<ReadonlyArray<AccountSummary>> {
      return collapse(await idbList(db));
    },

    async read(id: string): Promise<AccountVault | null> {
      const vault = await idbGet(db, id);
      return isAccountVault(vault) ? vault : null;
    },

    async write(summary: AccountSummary, vault: AccountVault): Promise<void> {
      await idbPut(db, summary.id, vault);
      const accounts = (await idbList(db)).filter(
        (account) => account.id !== summary.id && account.did !== summary.did,
      );
      await idbPut(db, LIST_KEY, [...accounts, summary]);
    },

    async remove(id: string): Promise<void> {
      await idbRun(db, STORE, 'readwrite', (store) => store.delete(id));
      const accounts = (await idbList(db)).filter((account) => account.id !== id);
      await idbPut(db, LIST_KEY, accounts);
    },
  });
}
