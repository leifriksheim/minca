/**
 * The terminal as an agent: `minca connect <code>` trades the app's code for
 * a records-only note from the account home, signed to a key made here that
 * never leaves (`packages/core/src/session/connect-code.ts`). Then `minca mcp`
 * and `minca agent` run a node of their own as the agent, under that note.
 * Kept in `<home>/agent/`, readable only by this user: `key.json`,
 * `grant.json`, `data/`, and `minca agent`'s model keys and `spend.json`.
 *
 * Each connect makes a new key: a key the home revoked stays revoked in every
 * space (`packages/core/src/space/roles.ts`, `judge`), so a new note made out
 * to it would write nothing. A running `minca mcp` takes the new key and note
 * up by itself ({@link reloadOnConnect}).
 */
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  CLOSE_DID_TAKEN,
  createNode,
  didOf,
  COLLECTION_DEFINE,
  type NodeConfig,
  type P2PNode,
} from '@minca/core';
import { profile } from '@minca/core/schemas';
import { checkGrant, connectWithCode, GRANT_VERSION, grantSigner, type Grant } from '@minca/core/session';
import { base64UrlDecode } from '@minca/core';
import { writeWhole } from './fs-directory.js';
import { fileStores } from './file-stores.js';
import { localPath, movedOut, nodeFor, type Unlocked } from './home.js';
import { commaList, errorCode, isRecord, messageOf } from './json.js';
import { holdLock, lockHolder } from './writer-keys.js';

/** The relay the apps meet on unless told otherwise */
const DEFAULT_RELAYS: ReadonlyArray<string> = ['wss://minca.fly.dev'];

/** Relays from `$MINCA_RELAYS` (comma separated), or the default */
export function configuredRelays(): string[] {
  const listed = commaList(process.env.MINCA_RELAYS);
  return listed.length ? listed : [...DEFAULT_RELAYS];
}

/**
 * Hosts from `$MINCA_HOSTS` (`https://host`, comma separated), where the node
 * looks for the account before it knows its host: on a server, it finds its
 * spaces over a host's socket without meeting a device first.
 */
const configuredHosts = () => commaList(process.env.MINCA_HOSTS);

/**
 * WebRTC, which Node doesn't have: the same API over libdatachannel. Loaded
 * only here — it is a native module, and the other commands don't need it.
 */
export async function enableWebRTC(): Promise<void> {
  if (typeof globalThis.RTCPeerConnection === 'function') return;
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } =
    await import('node-datachannel/polyfill');
  Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate });
}

const agentDir = (home: string) => path.join(home, 'agent');
/**
 * The agent's stores, with its key's places in each line: outside the home,
 * like an account's (`localPath`), and moved there once from `agent/data`.
 * No account id has a hyphen, so the name is the agent's alone.
 */
const agentData = (home: string) =>
  movedOut(path.join(agentDir(home), 'data'), localPath(home, 'agent-data'));

interface Stored {
  readonly keys: CryptoKeyPair;
  readonly did: string;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };

/** A new agent key, and the JWK `key.json` keeps of it. Used here only as a key that can't be exported. */
async function makeAgentKey(): Promise<Stored & { readonly jwk: string }> {
  const subtle = globalThis.crypto.subtle;
  const made = await subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const stored = {
    privateKey: await subtle.exportKey('jwk', made.privateKey),
    publicKey: await subtle.exportKey('jwk', made.publicKey),
  };
  const keys = {
    privateKey: await subtle.importKey('jwk', stored.privateKey, ALGORITHM, false, ['sign']),
    publicKey: made.publicKey,
  };
  return { keys, did: await didOf(keys.publicKey), jwk: `${JSON.stringify(stored)}\n` };
}

/** This computer's agent key, from `key.json`; null before `minca connect` made one */
async function readAgentKey(home: string): Promise<Stored | null> {
  const file = path.join(agentDir(home), 'key.json');
  const subtle = globalThis.crypto.subtle;
  try {
    const stored: unknown = JSON.parse(await readFile(file, 'utf8'));
    // importKey checks the rest of each key.
    if (!isRecord(stored) || !isRecord(stored.privateKey) || !isRecord(stored.publicKey))
      throw new Error('not a key pair');
    const keys = {
      privateKey: await subtle.importKey('jwk', stored.privateKey, ALGORITHM, false, ['sign']),
      publicKey: await subtle.importKey('jwk', stored.publicKey, ALGORITHM, true, ['verify']),
    };
    return { keys, did: await didOf(keys.publicKey) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`${file} could not be read. Delete it and connect again.`);
  }
}

/** The grant this computer's agent was given, or null before `minca connect` */
async function loadAgentGrant(home: string): Promise<Grant | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- written by connectAgent; startAgentNode checks it with checkGrant before use
    return JSON.parse(await readFile(path.join(agentDir(home), 'grant.json'), 'utf8')) as Grant;
  } catch {
    return null;
  }
}

/** Whether this computer's agent was connected to an account, and its note still runs */
export async function hasConnectedAgent(home: string): Promise<boolean> {
  const grant = await loadAgentGrant(home);
  return !!grant && grant.v === GRANT_VERSION && grant.expiresAt > Date.now() / 1000;
}

/** "Agent on leifs-macbook" — what the person sees in the app and their account */
export function defaultAgentName(): string {
  return `Agent on ${os.hostname().replace(/\.local$/, '')}`;
}

/**
 * Trades a code from the app for a records-only note, and keeps it.
 * @returns The grant, checked
 */
export async function connectAgent(params: {
  readonly home: string;
  readonly code: string;
  readonly relays: ReadonlyArray<string>;
  readonly name: string;
  readonly log: (line: string) => void;
  /** How the code is traded: the home's exchange, or a stand-in for tests */
  readonly connect?: typeof connectWithCode;
}): Promise<Grant> {
  const connect = params.connect ?? connectWithCode;
  if (!params.connect) await enableWebRTC();
  // A new key each time: one the home revoked can't write again, whatever note it is given.
  const key = await makeAgentKey();
  params.log('Looking for the app…');
  const grant = await connect({
    code: params.code,
    key: { keys: key.keys, did: key.did },
    name: params.name,
    recordsOnly: true,
    network: { relays: params.relays },
    onWaiting: ({ origin }) =>
      params.log(`Found ${origin}. Allow the agent there — it opens your account home.`),
  });

  // Another account's spaces don't belong next to this one's.
  const before = await loadAgentGrant(params.home);
  if (before && before.did !== grant.did)
    await rm(await agentData(params.home), { recursive: true, force: true });
  const kept = { ...grant, relays: [...new Set([...(grant.relays ?? []), ...params.relays])] };
  await mkdir(agentDir(params.home), { recursive: true, mode: 0o700 });
  // The key, then the grant made out to it: a running agent reloads when the grant changes.
  await writeWhole(path.join(agentDir(params.home), 'key.json'), key.jwk);
  await writeWhole(path.join(agentDir(params.home), 'grant.json'), `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}

/** Days until a grant runs out, rounded up — "30 days" just after asking for 30 */
export function daysLeft(grant: Grant): number {
  return Math.max(0, Math.ceil((grant.expiresAt - Date.now() / 1000) / 86_400));
}

const agentLock = (home: string) => path.join(agentDir(home), 'lock');

/** Thrown when another process on this computer already runs its agent */
export class AgentBusy extends Error {
  /** That process's id */
  readonly holder: number;
  constructor(holder: number) {
    super(
      `This computer’s agent is already running (pid ${holder}, another \`minca agent\` or \`minca mcp\`). Stop it first: two at once would sign with one key.`,
    );
    this.name = 'AgentBusy';
    this.holder = holder;
  }
}

/** The process running this computer's agent, or null when none is */
export const agentRunning = (home: string): Promise<number | null> => lockHolder(agentLock(home));

const run = promisify(execFile);
const psField = async (pid: number, field: string) =>
  (await run('ps', ['-o', `${field}=`, '-p', String(pid)])).stdout.trim();

/** The apps that start `minca mcp`, by their command line */
const CLIENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Claude\.app\//, 'Claude Desktop'],
  [/(^|\/)claude(\s|$)/, 'a Claude Code session'],
  [/Cursor/, 'Cursor'],
  [/Code( - Insiders)?\.app\/|(^|\/)code(\s|$)/, 'VS Code'],
  [/Windsurf/, 'Windsurf'],
];
/** What starts a process on the way to the app that asked for it, so skipped */
const LAUNCHERS = /^(npm|npx|node|bun|sh|bash|zsh|fish|env)$/;

/**
 * Says who runs the agent, for a person to recognise: "`minca mcp` (pid
 * 14578), started Thu Oct 15 17:57:54 2026 by a Claude Code session".
 * Read from `ps`; where there is none, just the pid.
 */
export async function describeAgentProcess(pid: number): Promise<string> {
  try {
    const command = await psField(pid, 'command');
    const what = /\bagent\b/.test(command) && !/\bmcp\b/.test(command) ? '`minca agent`' : '`minca mcp`';
    const started = await psField(pid, 'lstart');
    // Up past npx, node and shells to what launched it.
    let by = '';
    let parent = Number(await psField(pid, 'ppid'));
    for (let depth = 0; depth < 5 && parent > 1 && !by; depth += 1) {
      const line = await psField(parent, 'command');
      const name = path.basename(line.split(' ')[0] ?? '');
      by = CLIENTS.find(([pattern]) => pattern.test(line))?.[1] ?? (LAUNCHERS.test(name) ? '' : name);
      parent = Number(await psField(parent, 'ppid'));
    }
    return `${what} (pid ${pid}), started ${started}${by ? ` by ${by}` : ''}`;
  } catch {
    return `pid ${pid}`;
  }
}

/**
 * Stops the process running this computer's agent, waits for it to let go,
 * and starts the agent here instead.
 * @throws When it doesn't stop in time, or isn't this user's to stop
 */
export async function takeOverAgent(home: string, options: StartOptions = {}): Promise<RunningAgent> {
  const holder = await agentRunning(home);
  if (holder !== null) {
    try {
      // It closes its node and lets go of the lock on SIGTERM.
      process.kill(holder, 'SIGTERM');
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') throw new Error(`Couldn't stop pid ${holder}: ${messageOf(error)}`);
    }
    for (let waited = 0; (await agentRunning(home)) !== null; waited += 200) {
      if (waited >= 10_000)
        throw new Error(
          `pid ${holder} didn't stop within 10 seconds. Stop it by hand (kill ${holder}), then try again.`,
        );
      await delay(200);
    }
  }
  return startAgentNode(home, options);
}

export interface StartOptions {
  /** Nodes to reach by address, from `$MINCA_NODES` */
  readonly nodes?: ReadonlyArray<string>;
  /** How to reach peers instead of the relays: tests use a fake hub */
  readonly network?: NodeConfig['network'];
  /** Told once per space when the agent's key is revoked there */
  readonly onRevoked?: (space: string) => void;
}

/**
 * This computer's agent as it runs. Its node and grant change when `minca
 * connect` writes new ones and {@link RunningAgent.reload} takes them up, so
 * read them each time rather than keeping them.
 */
export interface RunningAgent {
  readonly node: P2PNode;
  readonly grant: Grant;
  /** The spaces where the key this node writes with was revoked: nothing it writes there counts */
  revoked(): ReadonlyArray<string>;
  /**
   * Starts the node again under the key and grant on disk, if `minca connect`
   * changed them, keeping the lock. A grant on disk that doesn't check out
   * (half written, or run out) is left alone.
   * @returns Whether it did
   */
  reload(): Promise<boolean>;
  close(): Promise<void>;
}

/** The grant and key on disk, checked, or why the agent can't run under them */
async function readConnection(home: string): Promise<{ grant: Grant; key: Stored }> {
  const grant = await loadAgentGrant(home);
  if (!grant)
    throw new Error(
      'No agent is connected on this computer. In the app, choose “Connect an agent” and run the command it shows.',
    );
  if (grant.v !== GRANT_VERSION)
    throw new Error(
      'The agent was connected by an older version, whose access no peer reads now. In the app, choose “Connect an agent” and run the new command.',
    );
  if (grant.expiresAt <= Date.now() / 1000)
    throw new Error(
      "The agent's access has run out. In the app, choose “Connect an agent” and run the new command.",
    );
  const key = await readAgentKey(home);
  if (!key)
    throw new Error(
      "The agent's key is gone. In the app, choose “Connect an agent” and run the command it shows.",
    );
  await checkGrant(grant, key.did, { recordsOnly: true });
  return { grant, key };
}

/**
 * Starts this computer's agent: a node of its own, following the account,
 * acting as the agent.
 * @throws Before `minca connect`, or once the note has run out; {@link AgentBusy} while another process runs it
 */
export async function startAgentNode(home: string, options: StartOptions = {}): Promise<RunningAgent> {
  const first = await readConnection(home);
  // One key, so one process signing with it: two at once would fork its log (spec 02 §4.10).
  const release = await holdLock(agentLock(home));
  if (!release) throw new AgentBusy((await agentRunning(home)) ?? 0);
  let current: { grant: Grant; key: Stored; node: P2PNode; stop(): Promise<void> };
  try {
    current = { ...first, ...(await startWithKey(home, first.grant, first.key, options)) };
  } catch (error) {
    await release();
    throw error;
  }

  let revokedIn = new Set<string>();
  const listen = (node: P2PNode) => {
    const told = new Set<string>();
    revokedIn = told;
    return node.subscribe((event) => {
      if (event.type !== 'revoked' || told.has(event.space)) return;
      told.add(event.space);
      options.onRevoked?.(event.space);
    });
  };
  let unlisten = listen(current.node);
  let closed = false;
  // One reload at a time, and none once closed: each closes the node before starting the next on the same folder.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };

  return Object.freeze({
    get node() {
      return current.node;
    },
    get grant() {
      return current.grant;
    },
    revoked: () => [...revokedIn],
    reload: () =>
      exclusive(async () => {
        if (closed) return false;
        const next = await readConnection(home).catch(() => null);
        if (!next || (next.key.did === current.key.did && sameGrant(next.grant, current.grant))) return false;
        unlisten();
        await current.stop();
        try {
          current = { ...next, ...(await startWithKey(home, next.grant, next.key, options)) };
        } catch (error) {
          // Back under what it had, so the session keeps what it could do.
          current = { ...current, ...(await startWithKey(home, current.grant, current.key, options)) };
          unlisten = listen(current.node);
          throw error;
        }
        unlisten = listen(current.node);
        return true;
      }),
    close: () =>
      exclusive(async () => {
        if (closed) return;
        closed = true;
        unlisten();
        await current.stop();
        await release();
      }),
  });
}

const sameGrant = (a: Grant, b: Grant) => JSON.stringify(a) === JSON.stringify(b);

/** The agent's node under one grant and key, and how to stop it without letting go of the lock */
async function startWithKey(
  home: string,
  grant: Grant,
  key: Stored,
  options: StartOptions,
): Promise<{ node: P2PNode; stop(): Promise<void> }> {
  if (!options.network) await enableWebRTC();
  const data = await agentData(home);
  const relays = [...new Set([...(grant.relays ?? []), ...configuredRelays()])];
  const base = await createNode({
    signer: grantSigner(grant),
    sessionKey: key.keys,
    stores: fileStores(data),
    ...(grant.accountKey ? { accountKey: base64UrlDecode(grant.accountKey) } : {}),
    network: options.network ?? {
      relays,
      hosts: configuredHosts(),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  // Spaces granted by name, when the grant wasn't for the whole account.
  const held = new Set((await base.spaces.list()).map((space) => space.id));
  for (const space of grant.spaces)
    if (!held.has(space.id)) await base.spaces.join(space.invite).catch(() => {});

  const node = await base.asAgent({ keys: key.keys, note: grant.note });
  const stopHolding = await holdEverySpace(node);
  return {
    node,
    stop: async () => {
      stopHolding();
      await node.close().catch(() => {});
      await base.close();
    },
  };
}

/** How long after `grant.json` changes the agent looks: `minca connect` writes the key, then the grant */
const SETTLE_MS = 250;
/** How often it looks anyway, for file systems that don't say when a file changes */
const LOOK_EVERY_MS = 30_000;

/**
 * Reloads a running agent when `minca connect` gives this computer a new key
 * and note, so a session using it needs no restart.
 * @returns How to stop watching
 */
export function reloadOnConnect(
  home: string,
  agent: RunningAgent,
  log: (line: string) => void,
  options: { readonly everyMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = () => {
    // One look at a time, a little after the first sign: a burst of events, or the regular look, doesn't put it off.
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void agent.reload().then(
        (changed) =>
          changed && log(`reconnected: an agent for ${agent.grant.name}, ${daysLeft(agent.grant)} days left`),
        (error: unknown) => log(`reconnecting failed: ${messageOf(error)}`),
      );
    }, SETTLE_MS);
  };
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(agentDir(home), (_event, file) => {
      if (file === null || file === 'grant.json') look();
    });
    watcher.on('error', () => {});
    watcher.unref();
  } catch {
    // No watching here: the regular look still finds it.
  }
  const every = setInterval(look, options.everyMs ?? LOOK_EVERY_MS);
  every.unref();
  return () => {
    watcher?.close();
    clearInterval(every);
    clearTimeout(timer);
  };
}

/** Forgets this computer's agent: its note and its copy of the spaces. The key stays, so connecting again replaces it at the home. */
export async function forgetAgent(home: string): Promise<void> {
  await rm(path.join(agentDir(home), 'grant.json'), { force: true });
  await rm(path.join(agentDir(home), 'data'), { recursive: true, force: true });
}

/**
 * Says a bot is one where apps keep profiles: `bot: true` on its
 * `std.profile`, an app convention. It adds `std.profile` where its role may;
 * false while the space keeps none.
 */
export async function discloseBot(node: P2PNode, space: string): Promise<boolean> {
  const collections = await node.collections.list(space);
  if (!collections.some((c) => c.name === profile.name && c.version !== null)) {
    if (!(await node.spaces.may(space, COLLECTION_DEFINE, { collection: profile.name }))) return false;
    await node.collections.define(space, profile);
  }
  const mine = (await node.records.list(space, { collection: profile.name })).find(
    (record) => record.root === node.did && !record.deleted,
  );
  const body = mine && isRecord(mine.body) ? mine.body : {};
  if (body.bot === true) return true;
  await (mine
    ? node.records.update(space, mine.key, { ...body, bot: true })
    : node.records.put(space, profile.name, { bot: true }));
  return true;
}

/**
 * Gives a bot's account the name it was made with, when it says none: spaces
 * know a member, and people mention it, by the name its account says.
 */
export async function nameBot(node: P2PNode, name: string): Promise<void> {
  if (!(await node.account.profile())) await node.account.setName(name);
}

/** A bot's node: its own account, online as an agent's is, named, holding every space and saying it is a bot there */
export async function startBotNode(
  unlocked: Unlocked,
  options: {
    readonly nodes?: ReadonlyArray<string>;
    /** Relays to meet devices on, over WebRTC. Default `$MINCA_RELAYS`; none, and it reaches only `nodes`. */
    readonly relays?: ReadonlyArray<string>;
    /** Once for each space it can't say it is a bot in yet, since the space keeps no `std.profile` */
    readonly undisclosed?: (space: string) => void;
  } = {},
): Promise<{ node: P2PNode; close(): Promise<void> }> {
  const relays = options.relays ?? configuredRelays();
  // Only a node that meets devices through relays needs WebRTC, a native module a host doesn't ship.
  if (relays.length) await enableWebRTC();
  const node = await nodeFor(unlocked, {
    network: {
      relays,
      hosts: configuredHosts(),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  await nameBot(node, unlocked.account.name);
  // Spaces it has not said it is a bot in: tried again as their records change, since `std.profile` may arrive later.
  const untold = new Set<string>();
  const trying = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const tell = (space: string) => {
    if (trying.has(space)) return;
    trying.add(space);
    void discloseBot(node, space)
      .then((told) => told && untold.delete(space))
      .catch(() => {})
      .finally(() => trying.delete(space));
  };
  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'records' && untold.has(event.space)) tell(event.space);
  });
  const stopHolding = await holdEverySpace(node, {
    onHold: (space) => {
      untold.add(space);
      tell(space);
      // Said only once the space has had time to arrive: a `std.profile` still on its way is no reason to.
      timers.push(setTimeout(() => untold.has(space) && options.undisclosed?.(space), UNDISCLOSED_AFTER_MS));
    },
  });
  return {
    node,
    close: async () => {
      stopHolding();
      timers.forEach(clearTimeout);
      unsubscribe();
      await node.close();
    },
  };
}

/** How long a bot waits for a space's `std.profile` before saying it can't disclose itself there */
const UNDISCLOSED_AFTER_MS = 20_000;

/** Where a provider's API key is kept: `anthropic-key`, `openai-key` */
const modelKeyFile = (home: string, provider: string) => path.join(agentDir(home), `${provider}-key`);

/** The API key `minca agent` was given for a provider, or null before it asked */
export async function loadModelKey(home: string, provider = 'anthropic'): Promise<string | null> {
  try {
    return (await readFile(modelKeyFile(home, provider), 'utf8')).trim() || null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Keeps the API key next to the agent's own key, readable only by this user */
export async function saveModelKey(home: string, key: string, provider = 'anthropic'): Promise<void> {
  await mkdir(agentDir(home), { recursive: true, mode: 0o700 });
  await writeFile(modelKeyFile(home, provider), `${key}\n`, { mode: 0o600 });
}

/**
 * Calls `onChange(true)` when every relay refused this agent because a socket
 * with the same agent key holds the room — one left from a crash, or a copy of
 * the agent elsewhere — and `onChange(false)` once one lets it in again.
 * Otherwise it would sit there looking connected (#162).
 */
export function watchRelayRefusal(node: P2PNode, onChange: (refused: boolean) => void): () => void {
  let refused = false;
  return node.subscribe((event) => {
    if (event.type !== 'network') return;
    const relays = node.network.status().relays;
    const now = relays.length > 0 && relays.every((relay) => relay.closeCode === CLOSE_DID_TAKEN);
    if (now === refused) return;
    refused = now;
    onChange(now);
  });
}

/**
 * Holds every space the node is in, and lets go of each it leaves, so each
 * syncs while it runs rather than on first use. Looks again whenever its spaces
 * change, and every `everyMs` for spaces another process added to the same
 * folder. A space that fails to open is tried again on the next look.
 * @returns How to stop looking
 */
export async function holdEverySpace(
  node: P2PNode,
  options: {
    readonly everyMs?: number;
    readonly onHold?: (space: string) => void;
    readonly onRelease?: (space: string) => void;
    readonly log?: (line: string) => void;
  } = {},
): Promise<() => void> {
  const held = new Map<string, () => Promise<void>>();
  const look = async () => {
    const ids = new Set((await node.spaces.list()).map((space) => space.id));
    for (const id of ids) {
      if (held.has(id)) continue;
      try {
        held.set(id, await node.spaces.hold(id));
        options.onHold?.(id);
      } catch (error) {
        options.log?.(`could not open space ${id}: ${messageOf(error)}`);
      }
    }
    for (const [id, release] of held) {
      if (ids.has(id)) continue;
      held.delete(id);
      await release();
      options.onRelease?.(id);
    }
  };
  // One look at a time, and one more queued behind it for whatever changed meanwhile.
  let running = Promise.resolve();
  let queued = false;
  const lookSoon = () => {
    if (queued) return running;
    queued = true;
    running = running
      .then(() => {
        queued = false;
        return look();
      })
      .catch((error: unknown) => options.log?.(`looking for spaces failed: ${messageOf(error)}`));
    return running;
  };
  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces') void lookSoon();
  });
  const timer = options.everyMs ? setInterval(() => void lookSoon(), options.everyMs) : undefined;
  await lookSoon();
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
