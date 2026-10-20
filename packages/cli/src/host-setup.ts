/**
 * What `minca host` starts from: a data folder, the host's key in it, and a
 * payment provider from the environment.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createP256Provider,
  createS3BlobStore,
  folderStores,
  type BlobStore,
  type HostLimits,
  type StoreFactory,
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

/** The host's stores, in the data folder: its subscriptions, and a copy of every space it carries */
export async function hostStores(data: string): Promise<StoreFactory> {
  return folderStores(await openFsDirectory(path.join(data, 'store')));
}

/** What a carried space takes on disk, in bytes: its folder under `hostStores`, walked */
export function spaceSize(data: string): (spaceId: string) => Promise<number> {
  const walk = async (dir: string): Promise<number> => {
    let bytes = 0;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) bytes += await walk(at);
      else if (entry.isFile()) bytes += (await stat(at)).size;
    }
    return bytes;
  };
  return (spaceId) =>
    /^[A-Za-z0-9_-]{1,120}$/.test(spaceId)
      ? walk(path.join(data, 'store', 'spaces', spaceId))
      : Promise.resolve(0);
}

/**
 * How much a subscription's spaces may take, from MINCA_HOST_QUOTA_GB: 10 on
 * a host that takes payments, none on a free one unless set. 0 is none.
 */
export function quotaFromEnv(env: NodeJS.ProcessEnv, free: boolean): number | undefined {
  const text = env.MINCA_HOST_QUOTA_GB?.trim();
  const gb = text ? Number(text) : free ? 0 : 10;
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
 * kept MINCA_HOST_KEEP_DAYS (90) after; a free subscription with no call for
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
    paidAccountBytes: gigabytesFromEnv(env, 'MINCA_HOST_QUOTA_GB', 10),
    space: {
      writers: wholeFromEnv(env, 'MINCA_HOST_SPACE_WRITERS', 10),
      bytes: wholeFromEnv(env, 'MINCA_HOST_SPACE_MB', 500) * 1_000_000,
      windowDays,
      readers: wholeFromEnv(env, 'MINCA_HOST_SPACE_READERS', 50),
    },
    graceDays: wholeFromEnv(env, 'MINCA_HOST_GRACE_DAYS', 30),
    keepDays: wholeFromEnv(env, 'MINCA_HOST_KEEP_DAYS', 90),
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
    ...(env.STRIPE_PRICE_MONTHLY ? { monthlyPrice: env.STRIPE_PRICE_MONTHLY } : {}),
    ...(env.STRIPE_PRICE_YEARLY ? { yearlyPrice: env.STRIPE_PRICE_YEARLY } : {}),
  });
}

/**
 * Wallet payments, when MINCA_WALLET_ADDRESS is set: USDC to that address, at
 * MINCA_WALLET_MONTHLY and/or MINCA_WALLET_YEARLY dollars, on
 * MINCA_WALLET_NETWORK (base, or base-sepolia to try it; default base), read
 * through MINCA_WALLET_RPC (default: the network's public node). None otherwise.
 */
export function walletFromEnv(env: NodeJS.ProcessEnv): WalletPayments | null {
  if (!env.MINCA_WALLET_ADDRESS) return null;
  const network = env.MINCA_WALLET_NETWORK ?? 'base';
  if (!isNetworkName(network))
    throw new Error(`MINCA_WALLET_NETWORK must be ${Object.keys(NETWORKS).join(' or ')}, not "${network}"`);
  if (!env.MINCA_WALLET_MONTHLY && !env.MINCA_WALLET_YEARLY) {
    throw new Error(
      'Wallet payments need a price: MINCA_WALLET_MONTHLY, MINCA_WALLET_YEARLY, or both, in dollars (like 4 and 36)',
    );
  }
  return createWalletPayments({
    network,
    to: env.MINCA_WALLET_ADDRESS,
    ...(env.MINCA_WALLET_MONTHLY ? { monthly: env.MINCA_WALLET_MONTHLY } : {}),
    ...(env.MINCA_WALLET_YEARLY ? { yearly: env.MINCA_WALLET_YEARLY } : {}),
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
 * Community funds: what keeping one online takes a month (MINCA_FUND_MONTHLY,
 * dollars, default the wallet's monthly price or 4), what a bot's AI use
 * costs as a multiple of what the host pays (MINCA_BOT_MARKUP, default 1.5),
 * and where someone who adds every month by card stops it
 * (STRIPE_PORTAL_LINK, Stripe's no-code customer portal link).
 */
export function fundFromEnv(env: NodeJS.ProcessEnv): {
  fundMonthly?: string;
  botMarkup?: number;
  manageFunds?: string;
} {
  const monthly = (env.MINCA_FUND_MONTHLY ?? env.MINCA_WALLET_MONTHLY)?.trim();
  if (monthly && !/^\d{1,5}(\.\d{1,2})?$/.test(monthly))
    throw new Error(`MINCA_FUND_MONTHLY must be dollars a month, like 4, not "${monthly}"`);
  const markup = env.MINCA_BOT_MARKUP ? Number(env.MINCA_BOT_MARKUP) : undefined;
  if (markup !== undefined && (!Number.isFinite(markup) || markup < 1))
    throw new Error(`MINCA_BOT_MARKUP must be 1 or more, not "${env.MINCA_BOT_MARKUP}"`);
  const portal = env.STRIPE_PORTAL_LINK?.trim();
  return {
    ...(monthly ? { fundMonthly: monthly } : {}),
    ...(markup !== undefined ? { botMarkup: markup } : {}),
    ...(portal ? { manageFunds: portal } : {}),
  };
}
