/**
 * The terminal as an agent: `minca connect` opens the account home with a
 * one-time code and gets a records-only note from it there, signed to a key
 * made here that never leaves (`packages/core/src/session/connect-code.ts`). Then `minca mcp`
 * and `minca agent` run a node of their own as the agent, under that note.
 *
 * A key signs in one process at a time, or its log forks (spec 02 §4.10), so
 * each session that runs at once has a key of its own: a numbered slot,
 * `<home>/agent/<n>/`, holding `key.json`, `grant.json`, its lock and what
 * only that session keeps. The spaces themselves are in one folder,
 * `<home>/agent/spaces/`, that every session reads and writes at once the
 * way clients share a data folder (spec 05 §14.5), so what one session
 * synced the next starts from. Beside
 * them, `minca agent`'s model keys and `spend.json`. All readable only by
 * this user.
 *
 * Each connect makes a new key: a key the home revoked stays revoked in every
 * space (`packages/core/src/space/roles.ts`, `judge`), so a new note made out
 * to it would write nothing. A running session takes its slot's new key and
 * note up by itself ({@link reloadOnConnect}).
 */
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createNode,
  directoryStores,
  didOf,
  folderStores,
  COLLECTION_DEFINE,
  type NodeConfig,
  type P2PNode,
} from '@minca/core';
import { profile } from '@minca/core/schemas';
import {
  checkGrant,
  connectCodeUrl,
  connectWithCode,
  newConnectCode,
  GRANT_VERSION,
  grantSigner,
  joinGranted,
  nodeOptionsFromGrant,
  usableGrant,
  type Grant,
} from '@minca/core/session';
import { openFsDirectory, writeWhole } from './fs-directory.js';
import { nodeFor, type Unlocked } from './home.js';
import { commaList, errorCode, isRecord, messageOf } from './json.js';
import { queue } from './queue.js';
import { holdLock, importKeyJwk, newKey } from './writer-keys.js';

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
/** How many sessions may run the agent at once, each with a key of its own */
const MAX_SLOTS = 16;
const slotDir = (home: string, slot: number) => path.join(agentDir(home), String(slot));

interface Stored {
  readonly keys: CryptoKeyPair;
  readonly did: string;
}

/** A slot's key, from its `key.json`; null before it was connected */
async function readAgentKey(slot: string): Promise<Stored | null> {
  const file = path.join(slot, 'key.json');
  try {
    const keys = await importKeyJwk(JSON.parse(await readFile(file, 'utf8')));
    if (!keys) throw new Error('not a key pair');
    return { keys, did: await didOf(keys.publicKey) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`${file} could not be read. Delete it and connect again.`);
  }
}

/** The grant a slot was given, or null before it was connected */
async function slotGrant(slot: string): Promise<Grant | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- written by connectAgent; startAgentNode checks it with checkGrant before use
    return JSON.parse(await readFile(path.join(slot, 'grant.json'), 'utf8')) as Grant;
  } catch {
    return null;
  }
}

/** The grant of the first connected slot, or null before `minca connect` */
export async function loadAgentGrant(home: string): Promise<Grant | null> {
  for (let n = 1; n <= MAX_SLOTS; n += 1) {
    const grant = await slotGrant(slotDir(home, n));
    if (grant) return grant;
  }
  return null;
}

/**
 * Whether the agent can run in a slot: its grant and key there check out. One
 * that doesn't (half written, or its note run out) counts as not connected, so
 * the session claiming it connects it again rather than fail to start.
 */
const runnable = (slot: string): Promise<boolean> =>
  readConnection(slot).then(
    () => true,
    () => false,
  );

/** A slot this process holds: no other runs with its key until it lets go */
export interface Slot {
  readonly dir: string;
  release(): Promise<void>;
}

/**
 * Claims a slot: the first connected one no other process holds, else the
 * first not connected yet, for this session to connect.
 * @throws When every slot is held
 */
export async function claimSlot(home: string): Promise<Slot> {
  await mkdir(agentDir(home), { recursive: true, mode: 0o700 });
  for (const connected of [true, false])
    for (let n = 1; n <= MAX_SLOTS; n += 1) {
      const dir = slotDir(home, n);
      if ((await runnable(dir)) !== connected) continue;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const release = await holdLock(path.join(dir, 'lock'));
      // Connected meanwhile by the process that held it: a later pass may still take it.
      if (release && (await runnable(dir)) === connected) return { dir, release };
      await release?.();
    }
  throw new Error(
    `Minca already runs in ${MAX_SLOTS} sessions on this computer. Close one, then start this one again.`,
  );
}

/** Whether a slot was connected to an account, and its note still runs */
export async function isConnected(slot: Slot): Promise<boolean> {
  return runnable(slot.dir);
}

/** "Agent on leifs-macbook" — what the person sees in the app and their account */
export function defaultAgentName(): string {
  return `Agent on ${os.hostname().replace(/\.local$/, '')}`;
}

/** Where the person allows an agent, unless they name another */
export const ACCOUNT_HOME = 'home.minca.social';

/**
 * Opens the account home at a new code, and keeps the records-only note the
 * person allows there.
 * @param params.onLink Given the link to open, before it waits: `open` it, show it, or both
 * @returns The grant, checked
 */
export async function connectAgent(params: {
  /** The slot it connects: one this process holds, or slot 1 for `minca connect`, whose session takes it up */
  readonly slot: string;
  readonly accountHome: string;
  readonly relays: ReadonlyArray<string>;
  readonly name: string;
  readonly onLink: (url: string) => void;
  /** Asks the person for the check code their home shows, until it matches (`connectWithCode`) */
  readonly check: (matches: (typed: string) => boolean) => Promise<void>;
  /** How the code is traded: the home's exchange, or a stand-in for tests */
  readonly connect?: typeof connectWithCode;
}): Promise<Grant> {
  const connect = params.connect ?? connectWithCode;
  if (!params.connect) await enableWebRTC();
  // A new key each time: one the home revoked can't write again, whatever note it is given.
  const made = await newKey();
  const key = { keys: made.keys, did: await didOf(made.keys.publicKey) };
  const code = newConnectCode();
  params.onLink(connectCodeUrl(params.accountHome, code));
  const grant = await connect({
    home: params.accountHome,
    check: params.check,
    code,
    key,
    name: params.name,
    network: { relays: params.relays },
  });

  // What this slot kept of another account doesn't belong to this one; the shared folder keeps each account apart.
  const before = await slotGrant(params.slot);
  if (before && before.did !== grant.did)
    await rm(path.join(params.slot, 'stores'), { recursive: true, force: true });
  // Slots connected to another account forget it: the next session handed one would write as that account.
  for (let n = 1; n <= MAX_SLOTS; n += 1) {
    const other = path.join(path.dirname(params.slot), String(n));
    const theirs = path.resolve(other) === path.resolve(params.slot) ? null : await slotGrant(other);
    if (theirs && theirs.did !== grant.did) await rm(path.join(other, 'grant.json'), { force: true });
  }
  const kept = { ...grant, relays: [...new Set([...(grant.relays ?? []), ...params.relays])] };
  await mkdir(params.slot, { recursive: true, mode: 0o700 });
  // The key, then the grant made out to it: a running agent reloads when the grant changes.
  await writeWhole(path.join(params.slot, 'key.json'), `${JSON.stringify(made.jwk)}\n`);
  await writeWhole(path.join(params.slot, 'grant.json'), `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}

/**
 * Connects the agent again from a terminal (`minca connect`): its first slot
 * gets the new key and note, and the other slots forget theirs, so each
 * session after asks for its own again rather than run on a note the person
 * may have revoked.
 */
export async function reconnectAgent(
  home: string,
  connect: (slot: string) => Promise<Grant>,
): Promise<Grant> {
  const grant = await connect(slotDir(home, 1));
  for (let n = 2; n <= MAX_SLOTS; n += 1)
    await rm(path.join(slotDir(home, n), 'grant.json'), { force: true });
  return grant;
}

/** Days until a grant runs out, rounded up — "30 days" just after asking for 30 */
export function daysLeft(grant: Grant): number {
  return Math.max(0, Math.ceil((grant.expiresAt - Date.now() / 1000) / 86_400));
}

const run = promisify(execFile);

/** Opens a link in the person's browser, if this computer has one; false when it couldn't */
export async function openInBrowser(url: string): Promise<boolean> {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url];
  try {
    await run(command, args);
    return true;
  } catch {
    return false;
  }
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

/** A slot's grant and key, checked, or why the agent can't run under them */
async function readConnection(slot: string): Promise<{ grant: Grant; key: Stored }> {
  const grant = await slotGrant(slot);
  if (!grant)
    throw new Error(
      'No agent is connected on this computer. In the app, choose “Connect an agent” and run the command it shows.',
    );
  if (!usableGrant(grant))
    throw new Error(
      grant.v !== GRANT_VERSION
        ? 'The agent was connected by an older version, whose access no peer reads now. In the app, choose “Connect an agent” and run the new command.'
        : "The agent's access has run out. In the app, choose “Connect an agent” and run the new command.",
    );
  const key = await readAgentKey(slot);
  if (!key)
    throw new Error(
      "The agent's key is gone. In the app, choose “Connect an agent” and run the command it shows.",
    );
  await checkGrant(grant, key.did, { recordsOnly: true });
  return { grant, key };
}

/**
 * Starts the agent in a slot this process holds: a node of its own, following
 * the account, acting as the agent. Closing it lets go of the slot.
 * @throws Before the slot was connected, or once its note has run out
 */
export async function startAgentNode(
  home: string,
  slot: Slot,
  options: StartOptions = {},
): Promise<RunningAgent> {
  let current: { grant: Grant; key: Stored; node: P2PNode; stop(): Promise<void> };
  try {
    const first = await readConnection(slot.dir);
    current = { ...first, ...(await startWithKey(home, slot.dir, first.grant, first.key, options)) };
  } catch (error) {
    await slot.release();
    throw error;
  }

  let revokedIn = new Set<string>();
  const listen = (node: P2PNode) => {
    const told = new Set<string>();
    revokedIn = told;
    return node.subscribe((event) => {
      if (event.type !== 'revoked' || told.has(event.space)) return;
      told.add(event.space);
      // A revoked key never writes again: the next session here connects the slot anew, with a new key.
      void rm(path.join(slot.dir, 'grant.json'), { force: true });
      options.onRevoked?.(event.space);
    });
  };
  let unlisten = listen(current.node);
  let closed = false;
  // One reload at a time, and none once closed: each closes the node before starting the next on the same folder.
  const exclusive = queue();

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
        const next = await readConnection(slot.dir).catch(() => null);
        if (!next || (next.key.did === current.key.did && sameGrant(next.grant, current.grant))) return false;
        unlisten();
        await current.stop();
        try {
          current = { ...next, ...(await startWithKey(home, slot.dir, next.grant, next.key, options)) };
        } catch (error) {
          // Back under what it had, so the session keeps what it could do.
          current = {
            ...current,
            ...(await startWithKey(home, slot.dir, current.grant, current.key, options)),
          };
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
        await slot.release();
      }),
  });
}

const sameGrant = (a: Grant, b: Grant) => JSON.stringify(a) === JSON.stringify(b);

/** The agent's node under one grant and key, and how to stop it without letting go of the slot */
async function startWithKey(
  home: string,
  slot: string,
  grant: Grant,
  key: Stored,
  options: StartOptions,
): Promise<{ node: P2PNode; stop(): Promise<void> }> {
  if (!options.network) await enableWebRTC();
  const { relays, ...keys } = nodeOptionsFromGrant(grant, configuredRelays());
  const base = await createNode({
    signer: grantSigner(grant),
    sessionKey: key.keys,
    // The spaces in the folder every session shares, one account apart from another; the rest, its key's places in its logs among them, in its slot.
    stores: folderStores(await openFsDirectory(path.join(agentDir(home), 'spaces')), {
      basePath: grant.did.replace(/^did:key:/, ''),
      local: directoryStores(await openFsDirectory(path.join(slot, 'stores'))),
    }),
    ...keys,
    network: options.network ?? {
      relays,
      hosts: configuredHosts(),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  // Spaces granted by name, when the grant wasn't for the whole account.
  await joinGranted(base, grant, () => {});

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
 * Reloads a running agent when `minca connect` gives its slot a new key and
 * note, so a session using it needs no restart.
 * @returns How to stop watching
 */
export function reloadOnConnect(
  slot: Slot,
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
    watcher = watch(slot.dir, (_event, file) => {
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

/** Forgets this computer's agent: every slot's note, and its copy of the spaces. The keys stay, so connecting again replaces them at the home. */
export async function forgetAgent(home: string): Promise<void> {
  for (let n = 1; n <= MAX_SLOTS; n += 1) {
    await rm(path.join(slotDir(home, n), 'grant.json'), { force: true });
    await rm(path.join(slotDir(home, n), 'stores'), { recursive: true, force: true });
  }
  await rm(path.join(agentDir(home), 'spaces'), { recursive: true, force: true });
  // Where a minca from before the slots kept its one connection.
  for (const old of ['key.json', 'grant.json', 'data'])
    await rm(path.join(agentDir(home), old), { recursive: true, force: true });
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
