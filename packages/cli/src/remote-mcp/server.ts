/**
 * `minca mcp-server`: Minca's MCP service on its own, apart from any host.
 * Chat apps connect to it by its address (`remote-mcp/index.ts`); each call
 * runs on a node that reaches the person's spaces through the always-on
 * nodes it is given (`MINCA_NODES`), such as the free host's, and nowhere
 * else. It keeps no key and no space past a session: a token carries the key,
 * and a session's spaces go when its node stops.
 *
 *   MINCA_MCP_URL     its public address, https:// (localhost may be http://)
 *   MINCA_NODES       the always-on nodes it reaches spaces through, wss://host/peer#did:key:…
 *   MINCA_MCP_DATA    where it keeps its token secret and its sign-ins under way. Default ~/.minca-mcp
 *   MINCA_MCP_HOME    the account home its consent page suggests
 *   MINCA_MCP_APPS    more chat apps a sign-in may go back to: hosts (chat.example.com) or schemes (zed:)
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { directoryStores } from '@minca/core';
import { openFsDirectory } from '../fs-directory.js';
import { addressOf } from '../host.js';
import { commaList, errorCode } from '../json.js';
import { holdLock } from '../writer-keys.js';
import { createRemoteMcp, type RemoteMcp } from './index.js';

export interface McpServerOptions {
  readonly publicUrl: string;
  /** The always-on nodes sessions reach spaces through */
  readonly nodes: ReadonlyArray<string>;
  readonly data: string;
  readonly port: number;
  readonly host?: string;
  readonly version: string;
  readonly accountHome?: string;
  readonly moreApps?: ReadonlyArray<string>;
  /** The header the proxy in front puts the asker's address in, when there is one */
  readonly clientAddressHeader?: string;
  readonly idleMs?: number;
  readonly running?: number;
  readonly log?: (line: string) => void;
}

/** The secret tokens are sealed under: made once, kept in the data folder, readable by this user only */
async function tokenSecret(data: string): Promise<Uint8Array> {
  const file = path.join(data, 'token-secret');
  try {
    const kept = new Uint8Array(Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'));
    if (kept.length === 32) return kept;
    throw new Error(`${file} is not 32 bytes. Delete it to make a new one; every app then connects again.`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const made = globalThis.crypto.getRandomValues(new Uint8Array(32));
  await writeFile(file, `${Buffer.from(made).toString('base64url')}\n`, { mode: 0o600 });
  return made;
}

/** A session's id is a token's: letters, digits, `-` and `_`, so one name, never a path */
function checkId(session: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) throw new Error('Not a session id');
  return session;
}

/** Where a session's node keeps its spaces while it runs */
const sessionFolder = (data: string, session: string) => path.join(data, 'sessions', checkId(session));

/**
 * Where a key's places in each log are kept, by its DID: past the node and
 * past a restart of the service, for as long as a token can last. A node that
 * forgot them would sign at a place it signed before, and fork the key.
 */
const placesFolder = (data: string, key: string) =>
  path.join(data, 'places', createHash('sha256').update(key).digest('base64url'));

/** How long what a token's node left is kept: as long as the token can last, and a day */
const KEEP_DAYS = 31;

/** Whether a folder holds a file anywhere under it */
async function holdsAFile(folder: string): Promise<boolean> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile());
}

/** Removes what tokens that can no longer be used left: their keys' places, and writes never sent */
async function sweep(data: string): Promise<void> {
  const before = Date.now() - KEEP_DAYS * 86_400_000;
  for (const root of [path.join(data, 'places'), path.join(data, 'sessions')])
    for (const entry of await readdir(root).catch(() => [])) {
      const at = path.join(root, entry);
      const since = await stat(at).then(
        (s) => s.mtimeMs,
        () => Date.now(),
      );
      if (since < before) await rm(at, { recursive: true, force: true });
    }
}

export async function startMcpServer(
  options: McpServerOptions,
): Promise<{ readonly port: number; readonly remote: RemoteMcp; close(): Promise<void> }> {
  await mkdir(options.data, { recursive: true, mode: 0o700 });
  // One process to a folder: two would each start a node for one token, sign at
  // the same places, and fork its key; and each would remove the other's spaces.
  const letGo = await holdLock(path.join(options.data, 'lock'));
  if (!letGo) throw new Error(`Another mcp-server is using ${options.data}`);
  try {
    return await serve(options, letGo);
  } catch (error) {
    await letGo();
    throw error;
  }
}

async function serve(
  options: McpServerOptions,
  letGo: () => Promise<void>,
): Promise<{ readonly port: number; readonly remote: RemoteMcp; close(): Promise<void> }> {
  // What an earlier run's nodes left, stopped by a crash, stays for the token's next call:
  // it may hold writes no always-on node has yet, whose places are already kept.
  await sweep(options.data);
  const store = await directoryStores(await openFsDirectory(path.join(options.data, 'store')))('mcp');
  const remote = await createRemoteMcp({
    publicUrl: options.publicUrl,
    secret: await tokenSecret(options.data),
    store,
    stores: (session, key) => {
      const folder = sessionFolder(options.data, session);
      const places = placesFolder(options.data, key);
      return async (where, storeOptions) =>
        directoryStores(await openFsDirectory(where === 'writers' ? places : folder))(where, storeOptions);
    },
    // Retried: a store may still be finishing its last write as the node stops.
    // Places it never signed at go too: a token that only read leaves nothing.
    drop: async (session, key) => {
      await rm(sessionFolder(options.data, session), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      const places = placesFolder(options.data, key);
      if (!(await holdsAFile(places))) await rm(places, { recursive: true, force: true });
    },
    addressOf: (req) => addressOf(req, options.clientAddressHeader),
    network: () => ({ relays: [], nodes: [...options.nodes] }),
    name: new URL(options.publicUrl).host,
    version: options.version,
    ...(options.accountHome ? { accountHome: options.accountHome } : {}),
    ...(options.moreApps ? { moreApps: options.moreApps } : {}),
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    ...(options.running !== undefined ? { running: options.running } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    void remote
      .routes(req, res)
      .then((answered) => {
        if (answered) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      })
      .catch((error: unknown) => {
        options.log?.(`mcp-server: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Something went wrong' }));
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  }).catch(async (error: unknown) => {
    await remote.close();
    await store.close();
    throw error;
  });
  const sweeping = setInterval(() => void sweep(options.data).catch(() => {}), 3_600_000);
  sweeping.unref();
  const address = http.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    remote,
    async close() {
      clearInterval(sweeping);
      await remote.close();
      await store.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await letGo();
    },
  };
}

/** The settings `minca mcp-server` takes from its environment */
export function mcpServerFromEnv(env: NodeJS.ProcessEnv) {
  const url = env.MINCA_MCP_URL?.trim();
  if (!url)
    throw new Error(
      'minca mcp-server needs MINCA_MCP_URL, its public https:// address: every token names it.',
    );
  const { protocol, hostname, pathname } = new URL(url);
  if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname))
    throw new Error('MINCA_MCP_URL must be https: sign-ins and tokens go through it.');
  if (pathname !== '/')
    throw new Error('MINCA_MCP_URL is an address like https://mcp.example.com, with no path');
  const nodes = commaList(env.MINCA_NODES);
  if (!nodes.length)
    throw new Error(
      'minca mcp-server needs MINCA_NODES, the always-on nodes it reaches spaces through, like wss://host.example/peer#did:key:…',
    );
  const apps = commaList(env.MINCA_MCP_APPS);
  const bad = apps.find(
    (app) =>
      !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(app) && !/^[a-z][a-z0-9+.-]*:$/i.test(app),
  );
  if (bad)
    throw new Error(`MINCA_MCP_APPS lists hosts like chat.example.com or schemes like zed:, not "${bad}"`);
  const home = env.MINCA_MCP_HOME?.trim();
  return {
    publicUrl: url.replace(/\/+$/, ''),
    nodes,
    data: env.MINCA_MCP_DATA?.trim() || path.join(os.homedir(), '.minca-mcp'),
    ...(home ? { accountHome: home } : {}),
    ...(apps.length ? { moreApps: apps.map((app) => app.toLowerCase()) } : {}),
  };
}
