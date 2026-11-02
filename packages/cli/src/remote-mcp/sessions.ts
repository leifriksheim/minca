/**
 * What a chat app acts with, and the node it acts through. The key and the
 * records-only note a person's account home signed travel inside the app's
 * access token, sealed under a key only the service holds (`oauth.ts`). Each
 * call opens them, and the node they start runs while the app is using it,
 * holding its spaces in memory. Nothing outlives it: a write is done once the
 * space's keepers have it, and a node started again carries on after what
 * they hold of its key's writes (`createWriters` in core).
 */
import { didOf, noteSpaces, type NodeConfig, type P2PNode } from '@minca/core';
import { checkGrant, usableGrant, type Grant } from '@minca/core/session';
import { startGrantedAgent } from '../agent.js';
import { isRecord, messageOf } from '../json.js';
import { importKeyJwk } from '../writer-keys.js';
import { boundedMemory } from './memory.js';

/** What a token carries: a key, and the note made out to it */
export interface Granted {
  /** The key the note is made out to, as JWK */
  readonly key: { readonly privateKey: JsonWebKey; readonly publicKey: JsonWebKey };
  readonly grant: Grant;
}

/** Most spaces one connection may be given: each is synced while it runs */
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
 * signs), and a records-only note for that key, signed by the account, for
 * some spaces, never the whole account, still running.
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
  if (noteSpaces(checked.note) === 'all' || checked.accountKey !== undefined || checked.scope !== 'spaces')
    throw new Error('A chat app here gets the spaces the person picks, not the whole account');
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
  /** The spaces it was given */
  readonly spaces: ReadonlyArray<string>;
  stop(): Promise<void>;
}

/** How long an idle node stays up for its writes the space's keepers don't have yet */
const UNKEPT_MS = 60 * 60_000;

/** Whether a node wrote something a space's keepers don't have yet: stopped, it would be lost */
async function unkept(started: Started): Promise<boolean> {
  for (const space of started.spaces)
    if ((await started.node.spaces.status(space).catch(() => null))?.pending) return true;
  return false;
}

/**
 * Waits up to `waitMs` for the node to be level with every always-on node
 * connected in a space, and at least one: nothing in flight either way, so it
 * holds what they hold. False when it wasn't, in time.
 */
async function levelIn(node: P2PNode, space: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const peers = await node.spaces.status(space).then(
      (status) => status.peers,
      () => [],
    );
    const level = await Promise.all(
      peers.map((peer) => node.spaces.reached(space, peer, Math.min(2000, left)).catch(() => false)),
    );
    if (level.length > 0 && level.every(Boolean)) return true;
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

  async function start(id: string, given: Granted): Promise<Started> {
    const keys = await importKeyJwk(given.key);
    if (!keys) throw new Error('The key could not be read');
    // Reaching only what it was given: what it reads, and the invites in its grant, are the account's to write.
    const agent = await startGrantedAgent({
      grant: given.grant,
      keys,
      // In memory: what it holds is the always-on nodes', and goes when it stops.
      stores: boundedMemory(options.budget),
      network: await options.network(given.grant),
    });
    // Disconnected at the account home: it reads and writes no more, from now on.
    const unsubscribe = agent.node.subscribe((event) => {
      if (event.type !== 'revoked') return;
      options.onRevoked?.(id);
      void stop(id);
    });
    return {
      node: agent.node,
      spaces: given.grant.spaces?.map((space) => space.id) ?? [],
      stop: async () => {
        unsubscribe();
        await agent.stop();
      },
    };
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
        // A node starts from nothing: one that answered sooner would say a record isn't
        // there, and write a first version in a line that has one, which ends it (09 §7.5).
        // Checked on every call, since a link that drops leaves it behind again.
        if (space !== undefined && !(await levelIn(started.node, space, CATCH_UP_MS)))
          throw new Error(
            'This space can’t be reached through the always-on nodes right now. Try again in a moment.',
          );
        return await work(started.node);
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
