/**
 * Where the CLI keeps accounts: a data folder, in exactly the layout a browser
 * uses. Point the CLI at the folder you picked in Chrome and both see the same
 * account and the same spaces.
 *
 * Nothing here ever writes the seed in the clear. An account is unlocked with
 * its recovery code or with a passphrase wrap — from a flag, an environment
 * variable, or a prompt — every time a process starts.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accountDataPath,
  createNode,
  createFolderAccountStore,
  createIdentityManager,
  createVault,
  deriveLocalKey,
  deriveAccountKey,
  deriveContactKeyBytes,
  folderStores,
  generateSeed,
  newAccountId,
  recoveryCodeToSeed,
  rootFromSeed,
  seedToRecoveryCode,
  unwrapSeedWithPassphrase,
  withWrap,
  wrapSeedWithPassphrase,
  CLI_PASSPHRASE_LABEL,
  type AccountStore,
  type AccountSummary,
  type NodeConfig,
  type P2PNode,
  type DirectoryHandleLike,
  type PassphraseWrap,
  type RootSigner,
  type StoreFactory,
  type WriterKeySource,
} from '@minca/core';
import { openFsDirectory } from './fs-directory.js';
import { fileStores } from './file-stores.js';
import { fileWriterKeys } from './writer-keys.js';

export interface Home {
  readonly path: string;
  readonly directory: DirectoryHandleLike;
  readonly accounts: AccountStore;
}

/** `--home`, then `$MINCA_HOME`, then `~/.minca`. */
export function homePath(flag?: string): string {
  return path.resolve(flag ?? process.env.MINCA_HOME ?? path.join(os.homedir(), '.minca'));
}

/**
 * Where this computer keeps an account's own stores: what it holds of each
 * space, and its place in each key's line. Never in the home, which may be a
 * folder a browser shares, or one a sync service copies to other machines:
 * whoever writes it would write these, and two machines would share them.
 * `$MINCA_LOCAL`, else the system's place for an app's state, under a name
 * worked out from the home's path.
 */
export function localPath(home: string, accountId: string): string {
  const base =
    process.env.MINCA_LOCAL ??
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'minca')
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'minca')
        : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'minca'));
  const which = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  return path.join(base, which, accountId);
}

/**
 * Where this computer keeps an account's writer keys and their places: under
 * {@link localPath}, never in the home, where whoever writes the folder could
 * roll a key's places back and have it sign at one again. Keys kept in the
 * home before are moved there once.
 */
async function writersPath(home: Home, accountId: string): Promise<string> {
  return movedOut(
    path.join(home.path, 'writers', accountId),
    path.join(localPath(home.path, accountId), 'writers'),
  );
}

/** `now`, after moving what was at `before` there, once, if anything was */
export async function movedOut(before: string, now: string): Promise<string> {
  if ((await stat(before).catch(() => null)) && !(await stat(now).catch(() => null))) {
    await mkdir(path.dirname(now), { recursive: true, mode: 0o700 });
    // Another disk: copy, then remove.
    await rename(before, now).catch(async () => {
      await cp(before, now, { recursive: true });
      await rm(before, { recursive: true, force: true });
    });
  }
  return now;
}

export async function openHome(flag?: string): Promise<Home> {
  const where = homePath(flag);
  const directory = await openFsDirectory(where);
  return { path: where, directory, accounts: createFolderAccountStore(directory) };
}

export interface Created {
  readonly account: AccountSummary;
  /** Present when the seed was generated here — shown once, stored nowhere */
  readonly code: string | null;
}

/**
 * Creates an account in the home, or adds an existing one from its code.
 * @param options.passphrase Also lock it with a passphrase, for unattended unlocking
 */
export async function createAccount(
  home: Home,
  options: { readonly name: string; readonly code?: string; readonly passphrase?: string },
): Promise<Created> {
  const seed = options.code ? recoveryCodeToSeed(options.code) : generateSeed();
  const { did } = await createIdentityManager().fromSeed(seed);

  if ((await home.accounts.list()).some((account) => account.did === did)) {
    throw new Error(`This home already has an account for ${did}`);
  }

  let vault = createVault({ did, label: options.name, wraps: [] });
  if (options.passphrase)
    vault = withWrap(vault, await wrapSeedWithPassphrase(seed, options.passphrase, CLI_PASSPHRASE_LABEL));

  const id = newAccountId();
  const account: AccountSummary = {
    id,
    name: options.name,
    did,
    createdAt: new Date().toISOString(),
    dataPath: accountDataPath(id),
  };
  await home.accounts.write(account, vault);
  return { account, code: options.code ? null : seedToRecoveryCode(seed) };
}

/** Picks an account by id, name or DID (`--account`, then `$MINCA_ACCOUNT`); the only one when there is exactly one. */
export async function chooseAccount(home: Home, flag?: string): Promise<AccountSummary> {
  const which = flag ?? process.env.MINCA_ACCOUNT;
  const accounts = await home.accounts.list();
  if (accounts.length === 0)
    throw new Error(
      `No account in ${home.path}. Run "minca init" first. (Connecting an agent needs no account here: "minca connect <code>".)`,
    );
  if (which) {
    const found = accounts.find(
      (account) => account.id === which || account.name === which || account.did === which,
    );
    if (!found) throw new Error(`No account called "${which}" in ${home.path}`);
    return found;
  }
  if (accounts.length > 1) {
    throw new Error(
      `Several accounts in ${home.path}; pick one with --account (${accounts.map((a) => a.name).join(', ')})`,
    );
  }
  return accounts[0]!;
}

export interface Unlocked {
  readonly account: AccountSummary;
  readonly signer: RootSigner;
  readonly stores: StoreFactory;
  /** Lets the node follow the account registry, so it joins every space the account does */
  readonly accountKey: Uint8Array;
  /** Opens contact requests sent to the account, and goes on its profile in every space */
  readonly contactKey: Uint8Array;
  /** Where this machine keeps the account's signing keys across runs, outside its data */
  readonly writerKey: WriterKeySource;
}

/**
 * Opens an account with its code or passphrase.
 * @throws When neither is given, or neither opens it
 */
export async function unlock(
  home: Home,
  account: AccountSummary,
  secret: { readonly code?: string; readonly passphrase?: string },
): Promise<Unlocked> {
  let seed: Uint8Array | null = null;

  if (secret.code) {
    seed = recoveryCodeToSeed(secret.code);
  } else if (secret.passphrase) {
    const vault = await home.accounts.read(account.id);
    const wraps = (vault?.wraps ?? []).filter((wrap): wrap is PassphraseWrap => wrap.kind === 'passphrase');
    if (wraps.length === 0)
      throw new Error(`"${account.name}" has no passphrase; unlock it with its recovery code`);
    for (const wrap of wraps) {
      try {
        seed = await unwrapSeedWithPassphrase(wrap, secret.passphrase, account.did);
        break;
      } catch {
        // Not this one.
      }
    }
    if (!seed) throw new Error('That passphrase does not open this account');
  } else {
    throw new Error(
      'Unlocking needs the recovery code (MINCA_RECOVERY_CODE) or a passphrase (MINCA_PASSPHRASE)',
    );
  }

  const { identity, signer } = await rootFromSeed(seed);
  if (identity.did !== account.did)
    throw new Error(`That code belongs to a different account than "${account.name}"`);

  const localKey = await deriveLocalKey(seed);
  return {
    account,
    signer,
    // The folder holds the registry and each space's segments; what this computer holds of them is its own.
    stores: folderStores(home.directory, {
      basePath: account.dataPath,
      localKey,
      local: fileStores(localPath(home.path, account.id)),
    }),
    accountKey: await deriveAccountKey(seed),
    contactKey: await deriveContactKeyBytes(seed),
    writerKey: fileWriterKeys(await writersPath(home, account.id), localKey, account.did),
  };
}

/** A node of the unlocked account, following its registry so it joins every space the account does */
export const nodeFor = (unlocked: Unlocked, extra: Partial<NodeConfig> = {}): Promise<P2PNode> =>
  createNode({
    signer: unlocked.signer,
    stores: unlocked.stores,
    accountKey: unlocked.accountKey,
    contactKey: unlocked.contactKey,
    writerKey: unlocked.writerKey,
    ...extra,
  });
