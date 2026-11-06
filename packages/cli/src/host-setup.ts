/**
 * What `minca host` starts from: a data folder, the host's key in it, and a
 * payment provider from the environment.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFolderAdapter,
  createP256Provider,
  createS3BlobStore,
  decodeKey,
  sqliteStores,
  type BatchOp,
  type BlobStore,
  type HostLimits,
  type SqliteStores,
  type Version,
} from '@minca/core';
import { openFsDirectory } from './fs-directory.js';
import type { Billing } from './host.js';
import { createStripeBilling } from './stripe.js';
import { createWalletPayments, isNetworkName, NETWORKS, type WalletPayments } from './wallet.js';
import { chooseModel, isLoopback, isPlain, thinker } from './model.js';
import { commaList } from './json.js';
import type { BotModel } from './hosted-bots.js';
import { createGitHubApp } from './connectors/github.js';
import { githubConnector } from './connectors/github-connector.js';
import type { HostConnector } from './connectors/connector.js';

/** Where a host keeps its data unless told: `~/.minca-host` */
export function defaultHostData(): string {
  return path.join(os.homedir(), '.minca-host');
}

/**
 * The host's own key — who it is to peers, and what accounts share their
 * carry spaces with. Made once and kept in the data folder, readable by this
 * user alone: a new key would be a new host, and every account would have to
 * hand its spaces over again.
 */
export async function hostKey(data: string, name = 'host-key'): Promise<CryptoKeyPair> {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const file = path.join(data, name);
  let seed: Uint8Array;
  try {
    seed = new Uint8Array(Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'));
  } catch {
    seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await writeFile(file, `${Buffer.from(seed).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  }
  const pair = await createP256Provider().deriveKeyPairFromSeed(seed);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/**
 * The host's stores, in one SQLite database in the data folder, `host.sqlite`:
 * its subscriptions, and a copy of every space it carries. A host that kept
 * them as folders, in `store/`, has them moved in the first time.
 */
export async function hostStores(data: string): Promise<SqliteStores> {
  await mkdir(data, { recursive: true, mode: 0o700 });
  // Loaded here, so only a host does: other commands run on any Node 22.
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(data, 'host.sqlite');
  const folder = path.join(data, 'store');
  if (existsSync(folder)) {
    // A folder beside a database is one written after the move, by an older release run again:
    // moved in, it would put back what the database has since changed.
    if (existsSync(file))
      throw new Error(
        `${folder} and ${file} are both here. Either the move into ${file} stopped before it put ` +
          `${folder} aside (then rename the folder ${folder}.imported), or an older release ran since ` +
          `and wrote the folder (then keep whichever holds what you want, and move the other away).`,
      );
    // Built aside and put in place whole: a move stopped halfway leaves no database to start from.
    const building = `${file}.importing`;
    for (const suffix of ['', '-wal', '-shm']) await rm(building + suffix, { force: true });
    const db = new DatabaseSync(building);
    await importStoreFolder(folder, sqliteStores(db));
    db.close();
    await rename(building, file);
    await rename(folder, await freeName(`${folder}.imported`));
  }
  return sqliteStores(new DatabaseSync(file));
}

/** `name`, or with the date after it when that is taken */
async function freeName(name: string): Promise<string> {
  return existsSync(name) ? `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}` : name;
}

/** What a carried space takes, in bytes: its keys, values and version bodies in `hostStores` */
export function spaceSize(stores: SqliteStores): (spaceId: string) => Promise<number> {
  return async (spaceId) => (/^[A-Za-z0-9_-]{1,120}$/.test(spaceId) ? stores.size(`spaces/${spaceId}`) : 0);
}

/** Entries or versions copied in one write, at most: a space's files must not all be in memory at once */
const IMPORT_BATCH = 256;

/**
 * Copies the stores a host kept as folders, one file per entry and per
 * version, into a database: every one as it was, writer keys' places
 * included, which must never go back.
 */
async function importStoreFolder(dir: string, stores: SqliteStores): Promise<void> {
  const paths = await storePaths(dir);
  const root = await openFsDirectory(dir);
  for (const storePath of paths) {
    const from = await createFolderAdapter(root, storePath);
    const to = await stores(storePath);
    let ops: BatchOp[] = [];
    let versions: Version[] = [];
    const flush = async () => {
      await to.commit!({ store: versions, ops, remove: [] });
      ops = [];
      versions = [];
    };
    for (const key of await from.list('')) {
      const value = await from.get(key);
      if (value) ops.push({ type: 'put', key, value });
      if (ops.length === IMPORT_BATCH) await flush();
    }
    for (const id of await from.listVersionIds()) {
      const version = await from.getVersion(id);
      if (version) versions.push(version);
      if (versions.length === IMPORT_BATCH) await flush();
    }
    await flush();
    await Promise.all([from.close(), to.close()]);
  }
}

/**
 * Every store kept in a folder of stores, as the path it was opened by: each
 * folder holding `kv` or `versions` is one.
 */
async function storePaths(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string, segments: string[]): Promise<void> => {
    const children = (await readdir(at, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (children.some((entry) => entry.name === 'kv' || entry.name === 'versions'))
      found.push(segments.map(decodeKey).join('/'));
    for (const child of children)
      if (child.name !== 'kv' && child.name !== 'versions')
        await walk(path.join(at, child.name), [...segments, child.name]);
  };
  await walk(dir, []);
  return found;
}

/**
 * How much a subscription's spaces may take at a host without limits, from
 * MINCA_HOST_QUOTA_GB: none unless set, as a balance pays for what they
 * take. 0 is none.
 */
export function quotaFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const text = env.MINCA_HOST_QUOTA_GB?.trim();
  const gb = text ? Number(text) : 0;
  if (!Number.isFinite(gb) || gb < 0)
    throw new Error(`MINCA_HOST_QUOTA_GB must be a number of gigabytes, not "${text}"`);
  return gb > 0 ? Math.round(gb * 1e9) : undefined;
}

/** A whole number from the environment, or what it is when unset */
function wholeFromEnv(env: NodeJS.ProcessEnv, name: string, otherwise: number): number {
  const text = env[name]?.trim();
  if (!text) return otherwise;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number, not "${text}"`);
  return value;
}

/** Gigabytes from the environment, as bytes */
function gigabytesFromEnv(env: NodeJS.ProcessEnv, name: string, otherwise: number): number {
  const text = env[name]?.trim();
  const gb = text ? Number(text) : otherwise;
  if (!Number.isFinite(gb) || gb < 0) throw new Error(`${name} must be a number of gigabytes, not "${text}"`);
  return Math.round(gb * 1e9);
}

/**
 * Free hosting within limits (spec 08 §1.1), when MINCA_HOST_FREE_GB is set:
 * the room an account has for free. MINCA_HOST_QUOTA_GB is then the room it
 * has while it pays (default 10). A space several accounts write in is free
 * up to MINCA_HOST_SPACE_WRITERS accounts writing (10) and MINCA_HOST_SPACE_MB
 * (500) over MINCA_HOST_WINDOW_DAYS (30); MINCA_HOST_SPACE_READERS (50) is
 * only shown. Past the line it is carried for MINCA_HOST_GRACE_DAYS (30), and
 * kept MINCA_HOST_KEEP_DAYS (30) after; a free subscription with no call for
 * MINCA_HOST_IDLE_DAYS (180) is dropped. None otherwise, and never with
 * MINCA_HOST_FREE=1, which has no limits at all.
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv, free: boolean): HostLimits | null {
  if (!env.MINCA_HOST_FREE_GB?.trim()) return null;
  if (free) throw new Error('MINCA_HOST_FREE_GB sets limits, and MINCA_HOST_FREE=1 has none: choose one');
  const windowDays = wholeFromEnv(env, 'MINCA_HOST_WINDOW_DAYS', 30);
  if (windowDays === 0) throw new Error('MINCA_HOST_WINDOW_DAYS must be at least 1');
  return {
    accountBytes: gigabytesFromEnv(env, 'MINCA_HOST_FREE_GB', 0),
    space: {
      writers: wholeFromEnv(env, 'MINCA_HOST_SPACE_WRITERS', 10),
      bytes: wholeFromEnv(env, 'MINCA_HOST_SPACE_MB', 500) * 1_000_000,
      windowDays,
      readers: wholeFromEnv(env, 'MINCA_HOST_SPACE_READERS', 50),
    },
    graceDays: wholeFromEnv(env, 'MINCA_HOST_GRACE_DAYS', 30),
    keepDays: wholeFromEnv(env, 'MINCA_HOST_KEEP_DAYS', 30),
    idleDays: wholeFromEnv(env, 'MINCA_HOST_IDLE_DAYS', 180),
  };
}

/**
 * How much one asker may take at a host with limits: MINCA_HOST_NEW_PER_DAY
 * new subscriptions a day from one address (default 5), and
 * MINCA_HOST_SPACES_PER_SUBSCRIPTION spaces carried for one (default 200).
 * Behind a proxy, MINCA_HOST_CLIENT_IP_HEADER names the header it gives the
 * asker's address in (`x-forwarded-for`, `cf-connecting-ip`); on Fly it is
 * Fly's own. Without one, every asker shares the proxy's address.
 */
export function abuseFromEnv(env: NodeJS.ProcessEnv): {
  newPerAddress: number;
  spacesPerSubscription: number;
  clientAddressHeader?: string;
} {
  const header = env.MINCA_HOST_CLIENT_IP_HEADER?.trim();
  return {
    newPerAddress: wholeFromEnv(env, 'MINCA_HOST_NEW_PER_DAY', 5),
    spacesPerSubscription: wholeFromEnv(env, 'MINCA_HOST_SPACES_PER_SUBSCRIPTION', 200),
    ...(header ? { clientAddressHeader: header } : {}),
  };
}

/** Stripe, when STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set; otherwise none */
export function billingFromEnv(env: NodeJS.ProcessEnv): Billing | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  return createStripeBilling({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  });
}

/**
 * Wallet payments, when MINCA_WALLET_ADDRESS is set: USDC to that address, on
 * MINCA_WALLET_NETWORK (base, or base-sepolia to try it; default base), read
 * through MINCA_WALLET_RPC (default: the network's public node). None otherwise.
 */
export function walletFromEnv(env: NodeJS.ProcessEnv): WalletPayments | null {
  if (!env.MINCA_WALLET_ADDRESS) return null;
  const network = env.MINCA_WALLET_NETWORK ?? 'base';
  if (!isNetworkName(network))
    throw new Error(`MINCA_WALLET_NETWORK must be ${Object.keys(NETWORKS).join(' or ')}, not "${network}"`);
  return createWalletPayments({
    network,
    to: env.MINCA_WALLET_ADDRESS,
    ...(env.MINCA_WALLET_RPC ? { rpcUrl: env.MINCA_WALLET_RPC } : {}),
  });
}

/**
 * How the host presents itself, from MINCA_HOST_NAME, MINCA_HOST_PRICE (text
 * for people; default from the wallet prices), MINCA_HOST_TERMS (an address),
 * and MINCA_HOST_URL (its public https:// address, where Stripe sends people
 * back to and reminder mails link to; default from each request).
 */
export function presentationFromEnv(env: NodeJS.ProcessEnv): {
  name?: string;
  price?: string;
  terms?: string;
  publicUrl?: string;
} {
  const url = env.MINCA_HOST_URL?.trim();
  if (url && !/^https?:\/\/[^/]+\/?$/.test(url))
    throw new Error(`MINCA_HOST_URL must be an address like https://host.example, not "${url}"`);
  return {
    ...(env.MINCA_HOST_NAME ? { name: env.MINCA_HOST_NAME } : {}),
    ...(env.MINCA_HOST_PRICE ? { price: env.MINCA_HOST_PRICE } : {}),
    ...(env.MINCA_HOST_TERMS ? { terms: env.MINCA_HOST_TERMS } : {}),
    ...(url ? { publicUrl: url.replace(/\/$/, '') } : {}),
  };
}

/**
 * The host's bucket, from MINCA_S3_ENDPOINT, MINCA_S3_BUCKET,
 * MINCA_S3_ACCESS_KEY_ID and MINCA_S3_SECRET_ACCESS_KEY (MINCA_S3_REGION and
 * MINCA_S3_PREFIX optional) — Cloudflare R2, or any S3-compatible store.
 * None when they are not set: the host keeps everything on its own disk.
 */
export function mirrorFromEnv(env: NodeJS.ProcessEnv): BlobStore | null {
  const { MINCA_S3_ENDPOINT, MINCA_S3_BUCKET, MINCA_S3_ACCESS_KEY_ID, MINCA_S3_SECRET_ACCESS_KEY } = env;
  if (!MINCA_S3_ENDPOINT || !MINCA_S3_BUCKET || !MINCA_S3_ACCESS_KEY_ID || !MINCA_S3_SECRET_ACCESS_KEY)
    return null;
  return createS3BlobStore({
    endpoint: MINCA_S3_ENDPOINT,
    bucket: MINCA_S3_BUCKET,
    accessKeyId: MINCA_S3_ACCESS_KEY_ID,
    secretAccessKey: MINCA_S3_SECRET_ACCESS_KEY,
    ...(env.MINCA_S3_REGION ? { region: env.MINCA_S3_REGION } : {}),
    ...(env.MINCA_S3_PREFIX ? { prefix: env.MINCA_S3_PREFIX } : {}),
  });
}

/**
 * The accounts a host carries for, from `--allow` and MINCA_HOST_ALLOW
 * (comma separated): account DIDs, as the home shows them. None: any.
 */
export function allowList(
  flags: ReadonlyArray<string> | undefined,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> | null {
  const named = [...(flags ?? []), ...commaList(env.MINCA_HOST_ALLOW)];
  if (named.length === 0) return null;
  const wrong = named.find((did) => !/^did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}$/.test(did));
  if (wrong)
    throw new Error(
      `"${wrong}" is not an account DID — copy it from the account home (Settings, under your name).`,
    );
  return [...new Set(named)];
}

/**
 * Refuses a free host anyone could reach and use: every subscription counts as
 * paid there, so a stranger could fill its disk. On this machine alone, or
 * limited to named accounts, it is fine.
 */
export function checkExposure(options: {
  readonly host?: string;
  readonly free?: boolean;
  readonly allow: ReadonlyArray<string> | null;
}): void {
  if (!options.free || options.allow || isLoopback(options.host)) return;
  throw new Error(
    `A free host on ${options.host} would carry spaces for anyone who finds it. Name the accounts it is for with --allow did:key:… (or MINCA_HOST_ALLOW), or keep it on this machine.`,
  );
}

/**
 * Bots the host runs for the spaces it carries, when MINCA_HOST_BOTS=1: they
 * think with the host's own key, each spends MINCA_BOT_DAILY_CAP dollars a
 * day at most (default 1), taken from their community's fund (`fundFromEnv`).
 * MINCA_BOT_PROVIDER, MINCA_BOT_MODEL, MINCA_BOT_BASE_URL and MINCA_BOT_PRICE
 * choose the model as `minca agent`'s flags do (`chooseModel`), with
 * claude-sonnet-5-5 by default. None otherwise.
 */
/**
 * The host's GitHub App, from MINCA_GITHUB_*: what connects its bots to
 * GitHub. All five or none; the private key as PEM, or a path to one.
 */
export async function githubFromEnv(env: NodeJS.ProcessEnv): Promise<HostConnector | null> {
  const names = [
    'MINCA_GITHUB_APP_ID',
    'MINCA_GITHUB_APP_SLUG',
    'MINCA_GITHUB_CLIENT_ID',
    'MINCA_GITHUB_CLIENT_SECRET',
    'MINCA_GITHUB_PRIVATE_KEY',
  ] as const;
  const given = names.filter((name) => env[name]?.trim());
  if (given.length === 0) return null;
  const missing = names.filter((name) => !given.includes(name));
  if (missing.length) throw new Error(`A GitHub App needs ${missing.join(', ')} too`);
  if (env.MINCA_HOST_BOTS !== '1')
    throw new Error('MINCA_GITHUB_* connects bots: it needs MINCA_HOST_BOTS=1');
  const key = env.MINCA_GITHUB_PRIVATE_KEY!.trim();
  const app = createGitHubApp({
    id: env.MINCA_GITHUB_APP_ID!.trim(),
    slug: env.MINCA_GITHUB_APP_SLUG!.trim(),
    clientId: env.MINCA_GITHUB_CLIENT_ID!.trim(),
    clientSecret: env.MINCA_GITHUB_CLIENT_SECRET!.trim(),
    privateKey: key.startsWith('-----BEGIN') ? key.replace(/\\n/g, '\n') : await readFile(key, 'utf8'),
    ...(env.MINCA_GITHUB_WEBHOOK_SECRET?.trim()
      ? { webhookSecret: env.MINCA_GITHUB_WEBHOOK_SECRET.trim() }
      : {}),
  });
  return githubConnector(app);
}

export async function botsFromEnv(
  env: NodeJS.ProcessEnv,
  data: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ folder: string; model: BotModel } | null> {
  if (env.MINCA_HOST_BOTS !== '1') return null;
  const model = chooseModel(
    {
      provider: env.MINCA_BOT_PROVIDER,
      model: env.MINCA_BOT_MODEL,
      price: env.MINCA_BOT_PRICE,
      baseUrl: env.MINCA_BOT_BASE_URL,
    },
    'claude-sonnet-5-5',
    { provider: 'MINCA_BOT_PROVIDER', model: 'MINCA_BOT_MODEL', price: 'MINCA_BOT_PRICE' },
  );
  const dailyCap = Number(env.MINCA_BOT_DAILY_CAP ?? '1');
  if (!Number.isFinite(dailyCap) || dailyCap <= 0)
    throw new Error(`MINCA_BOT_DAILY_CAP must be dollars a day, like 1, not "${env.MINCA_BOT_DAILY_CAP}"`);
  const openai = model.provider === 'openai';
  const apiKey = (openai ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)?.trim();
  // A server on this machine may ask for no key; OpenAI's and Anthropic's always do.
  if (!apiKey && !(openai && model.baseUrl && isLoopback(model.baseUrl)))
    throw new Error(
      openai
        ? `MINCA_BOT_PROVIDER=openai needs OPENAI_API_KEY for ${model.baseUrl ?? 'https://api.openai.com/v1'}`
        : 'MINCA_HOST_BOTS needs ANTHROPIC_API_KEY: the bots think with the host’s key',
    );
  const think = await thinker(model, apiKey ?? null, fetch);
  return {
    folder: path.join(data, 'bots'),
    model: {
      name: model.name,
      price: model.price,
      dailyCap,
      think: () => think(() => {}),
      ...(isPlain(model) ? { plain: true } : {}),
    },
  };
}

/**
 * Community funds: what keeping one online takes a month for each GB it
 * takes, at least one (MINCA_FUND_PER_GB, dollars, default 0.10), the least
 * one payment adds (MINCA_FUND_MIN, dollars, default 5: a card's fixed fee
 * stays small beside it), what a bot's AI use costs as a multiple of what the
 * host pays (MINCA_BOT_MARKUP, default 1.5), and where someone who adds every
 * month by card stops it (STRIPE_PORTAL_LINK, Stripe's no-code customer
 * portal link).
 */
export function fundFromEnv(env: NodeJS.ProcessEnv): {
  fundPerGb?: string;
  fundMin?: string;
  botMarkup?: number;
  manageFunds?: string;
} {
  const perGb = env.MINCA_FUND_PER_GB?.trim();
  if (perGb && !/^\d{1,5}(\.\d{1,4})?$/.test(perGb))
    throw new Error(`MINCA_FUND_PER_GB must be dollars a month for a GB, like 0.10, not "${perGb}"`);
  const min = env.MINCA_FUND_MIN?.trim();
  if (min && !/^\d{1,5}(\.\d{1,2})?$/.test(min))
    throw new Error(`MINCA_FUND_MIN must be dollars, like 5, not "${min}"`);
  const markup = env.MINCA_BOT_MARKUP ? Number(env.MINCA_BOT_MARKUP) : undefined;
  if (markup !== undefined && (!Number.isFinite(markup) || markup < 1))
    throw new Error(`MINCA_BOT_MARKUP must be 1 or more, not "${env.MINCA_BOT_MARKUP}"`);
  const portal = env.STRIPE_PORTAL_LINK?.trim();
  return {
    ...(perGb ? { fundPerGb: perGb } : {}),
    ...(min ? { fundMin: min } : {}),
    ...(markup !== undefined ? { botMarkup: markup } : {}),
    ...(portal ? { manageFunds: portal } : {}),
  };
}

/** Whether anyone may see the host's rounded totals at `/host/stats` (MINCA_HOST_STATS, public or off; default public) */
export function statsFromEnv(env: NodeJS.ProcessEnv): boolean {
  const given = env.MINCA_HOST_STATS?.trim() || 'public';
  if (given !== 'public' && given !== 'off')
    throw new Error(`MINCA_HOST_STATS is public or off, not "${given}"`);
  return given === 'public';
}
