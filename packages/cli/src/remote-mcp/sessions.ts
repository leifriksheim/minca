/**
 * What a chat app acts with, and the node it acts through. The key and the
 * records-only note a person's account home signed travel inside the app's
 * access token, sealed under a key only the service holds (`oauth.ts`). Each
 * call opens them, and the node they start runs while the app is using it,
 * holding the spaces its calls use in memory, the one used longest ago closed
 * when it needs the room. A write is done once the space's keepers have it.
 * What outlives the node is only where its key has signed (`places`): a key
 * that outlives its node must keep that, or the next would fork it.
 */
import {
  base64UrlDecode,
  deriveAccountRegistry,
  didOf,
  noteSpaces,
  type NodeConfig,
  type P2PNode,
  type StoreFactory,
} from '@minca/core';
import { checkGrant, usableGrant, type Grant } from '@minca/core/session';
import { startGrantedAgent } from '../agent.js';
import { isRecord, messageOf } from '../json.js';
import { importKeyJwk } from '../writer-keys.js';
import { boundedMemory, type BoundedMemory } from './memory.js';

/** What a token carries: a key, and the note made out to it */
export interface Granted {
  /** The key the note is made out to, as JWK */
  readonly key: { readonly privateKey: JsonWebKey; readonly publicKey: JsonWebKey };
  readonly grant: Grant;
}

/** Most spaces a grant may name: each comes with an invite, and the token carrying them goes in every request's headers */
const MAX_SPACES = 8;

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Whether a key pair's private half signs what its public half verifies */
async function holdsTogether(keys: CryptoKeyPair): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const said = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try {
    return await subtle.verify(ECDSA, keys.publicKey, await subtle.sign(ECDSA, keys.privateKey, said), said);
  } catch {
    return false;
  }
}

/** Whether a grant's note is still running, by the note itself: the grant's `expiresAt` is the home's word beside it */
function noteRunning(grant: Grant): boolean {
  const exp = grant.note.payload.exp;
  return exp !== undefined && exp > Math.floor(Date.now() / 1000);
}

function isKeyJwk(value: unknown): value is Granted['key'] {
  return isRecord(value) && isRecord(value.privateKey) && isRecord(value.publicKey);
}

/**
 * What a consent page posts, checked: a key pair whose halves belong
 * together (a note is no secret: it travels with every record its key
 * signs), and a records-only note for that key, signed by the account, still
 * running: for the whole account with its account key, or for the spaces it
 * names without one.
 * @throws When it isn't
 */
export async function checkGranted(key: unknown, grant: unknown): Promise<Granted> {
  if (!isKeyJwk(key)) throw new Error('That is not a key pair');
  const keys = await importKeyJwk(key);
  if (!keys) throw new Error('That is not a key pair');
  if (!(await holdsTogether(keys))) throw new Error('That private key is not the public key’s');
  if (!isRecord(grant)) throw new Error('That is not a grant');
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant checks it, and usableGrant its version and time
  const checked = grant as unknown as Grant;
  await checkGrant(checked, await didOf(keys.publicKey), { recordsOnly: true });
  if (!usableGrant(checked) || !noteRunning(checked))
    throw new Error('That grant has run out, or is of a version no peer reads');
  // Read from the note itself: the scope and the key beside it are only the home's word.
  const whole = noteSpaces(checked.note) === 'all';
  if (whole !== (checked.scope === 'account') || whole !== (checked.accountKey !== undefined))
    throw new Error('That grant’s note and its scope don’t agree');
  if (checked.spaces.length > MAX_SPACES) throw new Error(`Pick at most ${MAX_SPACES} spaces for a chat app`);
  return { key, grant: checked };
}

/** How long a node stays up after its last call */
const IDLE_MS = 10 * 60_000;
/** Nodes running at once: a start past it waits for one to stop */
const RUNNING = 32;
/** How long a start waits for room before giving up */
const ROOM_WAIT_MS = 30_000;

/** How long a call waits for its node to be level with an always-on node in its space */
const CATCH_UP_MS = 15_000;

interface Started {
  readonly node: P2PNode;
  readonly memory: BoundedMemory;
  /** For a grant of the whole account: the account registry, which lists its spaces */
  readonly registry: string | null;
  /** The spaces it opened, with the calls running in each, the one used last at the end */
  readonly open: Map<string, { busy: number }>;
  /** Spaces being closed: one is opened again only once it has */
  readonly closing: Map<string, Promise<void>>;
  /** Whether the person disconnected it: nothing more is answered */
  revoked: boolean;
  stop(): Promise<void>;
}

/** How long an idle node stays up for its writes the space's keepers don't have yet */
const UNKEPT_MS = 60 * 60_000;

/** Whether a space holds something this node wrote that the keepers don't have yet: closed, it would be lost */
async function holdsUnkept(node: P2PNode, space: string): Promise<boolean> {
  return Boolean((await node.spaces.status(space).catch(() => null))?.pending);
}

/** Whether a node wrote something a space's keepers don't have yet: stopped, it would be lost */
async function unkept(started: Started): Promise<boolean> {
  for (const space of started.open.keys()) if (await holdsUnkept(started.node, space)) return true;
  return false;
}

/** Where a space's copy is kept (`openSpaceRuntime` in `packages/core/src/node/space-runtime.ts`) */
const spaceStore = (space: string) => `spaces/${space}`;

/** Closes a space and forgets its copy: opened again, it syncs from the keepers */
async function closeSpace(started: Started, space: string): Promise<void> {
  started.open.delete(space);
  const closed = (async () => {
    // Held and let go, it closes: the node keeps nobody else's hold on a session's spaces.
    const release = await started.node.spaces.hold(space);
    await release();
    started.memory.drop(spaceStore(space));
  })().catch(() => {});
  started.closing.set(space, closed);
  await closed;
  if (started.closing.get(space) === closed) started.closing.delete(space);
}

/** Most spaces a node keeps open at once: each holds sockets and timers, however little it stores */
const MAX_OPEN = 8;

/**
 * Makes room for `space`: while the node holds more than half its budget, or
 * more than {@link MAX_OPEN} spaces, closes the space used longest ago. Never
 * one a call is using, or one holding a write the keepers don't have yet.
 */
async function makeRoom(started: Started, space: string): Promise<void> {
  const full = () => started.memory.used() > started.memory.budget / 2 || started.open.size > MAX_OPEN;
  for (const [other, one] of [...started.open]) {
    if (!full()) return;
    if (other === space || one.busy > 0 || (await holdsUnkept(started.node, other))) continue;
    // A call may have started in it meanwhile.
    if (one.busy === 0 && started.open.get(other) === one) await closeSpace(started, other);
  }
}

/** How long a call waits for a space the account joined meanwhile to reach the list in its registry */
const LISTED_MS = 5_000;

/** Whether the grant reaches a space: one it names, or for the whole account, one the account is in */
async function reaches(started: Started, space: string): Promise<boolean> {
  const deadline = Date.now() + (started.registry ? LISTED_MS : 0);
  for (;;) {
    if ((await started.node.spaces.list()).some((one) => one.id === space)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** What a call in a space the grant doesn't reach is told */
async function whyNot(started: Started): Promise<string> {
  if (!started.registry)
    return (
      'This space isn’t connected. To use it here, the person connects Minca again from this chat app and ' +
      'chooses it, or chooses all spaces.'
    );
  // The list comes from the account registry, which only the account's devices and hosts hold.
  const peers = await started.node.spaces.status(started.registry).then(
    (status) => status.peers.length,
    () => 0,
  );
  return peers > 0
    ? 'This isn’t one of the person’s spaces: spaces_list shows the ones this connection can use.'
    : 'The person’s list of spaces can’t be reached right now: none of their devices or hosts that keep it ' +
        'is online. Opening their account home brings it back.';
}

/**
 * Waits up to `waitMs` for the node to be level with the space's keepers
 * connected now, and at least one: nothing in flight either way, so it holds
 * what they hold. Only keepers count, the nodes the space names to keep it
 * whole: any member may connect and never answer. In a space that names
 * none, any one peer that is level will do. False when it wasn't, in time.
 */
async function levelIn(node: P2PNode, space: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const [peers, keepers] = await Promise.all([
      node.spaces.status(space).then(
        (status) => status.peers,
        () => [],
      ),
      node.spaces.access(space).then(
        (access) => new Set(access.keepers.map((keeper) => keeper.did)),
        () => new Set<string>(),
      ),
    ]);
    const asked = keepers.size > 0 ? peers.filter((peer) => keepers.has(peer)) : peers;
    const level = await Promise.all(
      asked.map((peer) => node.spaces.reached(space, peer, Math.min(2000, left)).catch(() => false)),
    );
    if (keepers.size > 0 ? level.length > 0 && level.every(Boolean) : level.some(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, left)));
  }
}

interface Running {
  readonly started: Promise<Started>;
  timer?: ReturnType<typeof setTimeout>;
  /** When a call last ended */
  used: number;
  /** Calls running on it now: it isn't stopped under them */
  busy: number;
}

export interface Sessions {
  /**
   * Runs `work` on the node for session `id`, started from `granted` if it
   * isn't running. One node per session, ever: two signing with one key
   * would fork its line. Work in a space runs only once the node is level
   * with the always-on nodes there.
   */
  use<T>(
    id: string,
    granted: Granted,
    space: string | undefined,
    work: (node: P2PNode) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export function createSessions(options: {
  /** How a session's node reaches the spaces it was given: the always-on nodes that hold them */
  readonly network: (grant: Grant) => Promise<NodeConfig['network']>;
  /** What a session's node may hold, in bytes */
  readonly budget?: number;
  /**
   * Where a key, by DID, keeps its places in its logs: past the node, since its
   * token lasts for weeks and a node that forgot them would sign at a place it
   * used, forking the key. In memory with the rest by default.
   */
  readonly places?: (key: string) => StoreFactory;
  /** Told once a session's key was revoked in some space: the person disconnected the app */
  readonly onRevoked?: (id: string) => void;
  readonly idleMs?: number;
  readonly running?: number;
  readonly log?: (line: string) => void;
}): Sessions {
  const log = options.log ?? (() => {});
  /** Nodes running, the one used last at the end */
  const running = new Map<string, Running>();
  /** Nodes stopping: one starts again with the same key only once it has */
  const stopping = new Map<string, Promise<void>>();
  /** Nodes given room to run: started or starting, never more than the cap */
  const granted = new Set<string>();

  const stop = async (id: string) => {
    const one = running.get(id);
    if (!one) return stopping.get(id);
    running.delete(id);
    clearTimeout(one.timer);
    const stopped = one.started.then((started) => started.stop()).catch(() => {});
    stopping.set(id, stopped);
    await stopped;
    granted.delete(id);
    if (stopping.get(id) === stopped) stopping.delete(id);
  };

  const idleLater = (id: string) => {
    const one = running.get(id);
    if (!one) return;
    clearTimeout(one.timer);
    one.timer = setTimeout(() => {
      void (async () => {
        if (one.busy > 0) return idleLater(id);
        // Its writes the keepers don't have yet would go with it: it waits for them, for a while.
        const waiting = await one.started.then(unkept, () => false);
        if (waiting && Date.now() - one.used < UNKEPT_MS) return idleLater(id);
        await stop(id);
      })();
    }, options.idleMs ?? IDLE_MS);
    one.timer.unref?.();
  };

  /** Takes a place to run: a free one, or one a node with no call running gives up, or waits */
  const roomFor = async (id: string) => {
    const cap = options.running ?? RUNNING;
    const giveUp = Date.now() + ROOM_WAIT_MS;
    for (;;) {
      if (granted.size < cap) {
        granted.add(id);
        return;
      }
      const idle = [...running].find(([other, one]) => other !== id && granted.has(other) && one.busy === 0);
      if (idle) await stop(idle[0]);
      else if (Date.now() > giveUp) throw new Error('This service is busy. Try again in a moment.');
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** What a session's node holds in memory, but for its key's places, which last */
  function storesFor(given: Granted, memory: BoundedMemory): StoreFactory {
    const places = options.places?.(given.grant.note.payload.aud);
    return (where, storeOptions) =>
      (where === 'writers' && places ? places : memory.stores)(where, storeOptions);
  }

  async function start(id: string, given: Granted): Promise<Started> {
    const keys = await importKeyJwk(given.key);
    if (!keys) throw new Error('The key could not be read');
    const memory = boundedMemory(options.budget);
    // Reaching only what it was given: what it reads, and the invites in its grant, are the account's to write.
    const agent = await startGrantedAgent({
      grant: given.grant,
      keys,
      // In memory: what it holds is the always-on nodes', and goes when it stops.
      stores: storesFor(given, memory),
      network: await options.network(given.grant),
    });
    const { accountKey } = given.grant;
    const registry = accountKey
      ? (await deriveAccountRegistry(base64UrlDecode(accountKey), given.grant.did)).space.id
      : null;
    const started: Started = {
      node: agent.node,
      memory,
      registry,
      // The spaces it joined from the grant, open already: the first to close when it needs room.
      open: new Map(given.grant.spaces.map((space) => [space.id, { busy: 0 }])),
      closing: new Map(),
      revoked: false,
      stop: async () => {
        unsubscribe();
        await agent.stop();
      },
    };
    // Disconnected at the account home: it reads and writes no more, from now on.
    const unsubscribe = agent.node.subscribe((event) => {
      if (event.type !== 'revoked') return;
      started.revoked = true;
      options.onRevoked?.(id);
      void stop(id);
    });
    // The account's spaces are listed in its registry: level with it, the list is whole.
    if (registry) await levelIn(agent.node, registry, CATCH_UP_MS);
    return started;
  }

  /** Opens a space for a call, closing others for room, and runs `work` once the node is level there */
  async function inSpace<T>(started: Started, space: string, work: () => Promise<T>): Promise<T> {
    if (!(await reaches(started, space))) throw new Error(await whyNot(started));
    // Nothing awaited between seeing it isn't closing and marking it used, or it could start closing.
    for (let closing = started.closing.get(space); closing; closing = started.closing.get(space))
      await closing;
    const one = started.open.get(space) ?? { busy: 0 };
    // Used now: last in line to be closed.
    started.open.delete(space);
    started.open.set(space, one);
    one.busy += 1;
    try {
      await makeRoom(started, space);
      // A node starts from nothing: one that answered sooner would say a record isn't
      // there, and write a first version in a line that has one, which ends it (09 §7.5).
      // Checked on every call, since a link that drops leaves it behind again.
      if (!(await levelIn(started.node, space, CATCH_UP_MS)))
        throw new Error(
          'This space can’t be reached through the always-on nodes right now. Try again in a moment.',
        );
      return await work();
    } finally {
      one.busy -= 1;
    }
  }

  /** The session's node: running, or started now and marked running before anything is awaited */
  function nodeOf(id: string, given: Granted): Running {
    const one = running.get(id);
    if (one) {
      // Used now: last in line to be stopped.
      running.delete(id);
      running.set(id, one);
      return one;
    }
    const made: Running = {
      used: Date.now(),
      busy: 0,
      started: (async () => {
        await stopping.get(id);
        await roomFor(id);
        return start(id, given);
      })(),
    };
    running.set(id, made);
    made.started.catch((error: unknown) => {
      log(`session: could not start: ${messageOf(error)}`);
      if (running.get(id) === made) {
        running.delete(id);
        granted.delete(id);
      }
    });
    return made;
  }

  return {
    async use(id, given, space, work) {
      if (!noteRunning(given.grant)) throw new Error('This connection has run out. Connect again.');
      const one = nodeOf(id, given);
      one.busy += 1;
      try {
        const started = await one.started;
        const answer = () => {
          if (started.revoked) throw new Error('This connection was disconnected. Connect again.');
          return work(started.node);
        };
        return await (space === undefined ? answer() : inSpace(started, space, answer));
      } finally {
        one.busy -= 1;
        one.used = Date.now();
        idleLater(id);
      }
    },
    async close() {
      await Promise.all([...running.keys()].map(stop));
    },
  };
}
