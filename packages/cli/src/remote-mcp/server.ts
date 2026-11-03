/**
 * `minca mcp-server`: Minca's MCP service on its own, apart from any host.
 * Chat apps connect to it by its address (`remote-mcp/index.ts`). It keeps
 * each connection's key sealed under one only its token carries, and each session's node
 * holds its spaces in memory while it runs, reaching them through the
 * always-on nodes and relays its invites and spaces name, on the public
 * internet only (`reach.ts`), and these.
 *
 *   MINCA_MCP_URL     its public address, https:// (localhost may be http://)
 *   MINCA_NODES       always-on nodes of the operator's own, wss://host/peer#did:key:…, besides those spaces name
 *   MINCA_RELAYS      relays sessions meet devices through, besides those spaces name. Default wss://relay.minca.social
 *   MINCA_MCP_DATA    where it keeps its token secret, sign-ins under way and sealed keys. Default ~/.minca-mcp
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
import { createRemoteMcp, type RemoteMcp } from './index.js';
import { publicNode } from './reach.js';
import { configuredRelays, enableWebRTC } from '../agent.js';

export interface McpServerOptions {
  readonly publicUrl: string;
  /** Always-on nodes of the operator's own, besides those a grant's invites and spaces name */
  readonly nodes?: ReadonlyArray<string>;
  /** Relays its sessions meet devices through, besides those the spaces name: WebRTC, for an open tab */
  readonly relays?: ReadonlyArray<string>;
  /** Whether a session may reach a node, relay or host it found; public addresses only, by default */
  readonly mayReach?: (node: string) => Promise<boolean>;
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

/** How long a key's places are kept: as long as its token can last, and a day */
const PLACES_DAYS = 31;

/** Removes the places of keys whose tokens can no longer be used, and those of keys that never signed */
async function sweepPlaces(data: string): Promise<void> {
  const root = path.join(data, 'places');
  const before = Date.now() - PLACES_DAYS * 86_400_000;
  for (const entry of await readdir(root).catch(() => [])) {
    const at = path.join(root, entry);
    const files = (await readdir(at, { recursive: true, withFileTypes: true }).catch(() => [])).filter(
      (file) => file.isFile(),
    );
    // When it was last written in: the folder's own time doesn't change with what is under it.
    const times = await Promise.all(
      [at, ...files.map((file) => path.join(file.parentPath, file.name))].map((where) =>
        stat(where).then(
          (found) => found.mtimeMs,
          () => 0,
        ),
      ),
    );
    const since = Math.max(...times);
    // One with nothing in it a day on: a key that only read, its node long stopped.
    const unused = files.length === 0 && since < Date.now() - 86_400_000;
    if (since < before || unused) await rm(at, { recursive: true, force: true });
  }
}

export async function startMcpServer(
  options: McpServerOptions,
): Promise<{ readonly port: number; readonly remote: RemoteMcp; close(): Promise<void> }> {
  await mkdir(options.data, { recursive: true, mode: 0o700 });
  // Meeting an open tab, or a member's device, takes WebRTC.
  if (options.relays?.length) await enableWebRTC();
  await sweepPlaces(options.data);
  const sweeping = setInterval(() => void sweepPlaces(options.data).catch(() => {}), 3_600_000);
  sweeping.unref();
  const store = await directoryStores(await openFsDirectory(path.join(options.data, 'store')))('mcp');
  const remote = await createRemoteMcp({
    publicUrl: options.publicUrl,
    secret: await tokenSecret(options.data),
    store,
    addressOf: (req) => addressOf(req, options.clientAddressHeader),
    // The nodes its invites name that are public, and the operator's own: nowhere a stranger's grant points.
    // Its own relays and nodes as given; any other a grant's invites or the spaces name, only on the
    // public internet: what a session reads is a stranger's to write, never where the service connects.
    // A key's places outlast its node, by its DID: forgotten, a node would sign at a place it used.
    places: (key) => {
      const folder = path.join(options.data, 'places', createHash('sha256').update(key).digest('base64url'));
      return async (where, storeOptions) =>
        directoryStores(await openFsDirectory(folder))(where, storeOptions);
    },
    network: async () => ({
      relays: [...(options.relays ?? [])],
      nodes: [...(options.nodes ?? [])],
      reach: options.mayReach ?? publicNode,
    }),
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
    clearInterval(sweeping);
    await remote.close();
    await store.close();
    throw error;
  });
  const address = http.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    remote,
    async close() {
      clearInterval(sweeping);
      await remote.close();
      await store.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
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
    ...(nodes.length ? { nodes } : {}),
    relays: configuredRelays(),
    data: env.MINCA_MCP_DATA?.trim() || path.join(os.homedir(), '.minca-mcp'),
    ...(home ? { accountHome: home } : {}),
    ...(apps.length ? { moreApps: apps.map((app) => app.toLowerCase()) } : {}),
  };
}
