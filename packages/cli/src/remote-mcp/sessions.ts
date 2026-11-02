/**
 * What a chat app acts with, and the node it acts through. The key and the
 * records-only note a person's account home signed travel inside the app's
 * access token, sealed under a key only the service holds (`oauth.ts`). Each
 * call opens them, and the node they start runs while the app is using it,
 * its spaces kept in a folder that goes when it stops. Only where the key has
 * signed in each log outlives the node (`server.ts`): a node that forgot it
 * would sign at a place it signed before, and fork the key.
 */
import { didOf, noteSpaces, type NodeConfig, type P2PNode, type StoreFactory } from '@minca/core';
import { checkGrant, usableGrant, type Grant } from '@minca/core/session';
import { startGrantedAgent } from '../agent.js';
import { isRecord, messageOf } from '../json.js';
import { importKeyJwk } from '../writer-keys.js';

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

/** How long a call waits for its node to catch up with the always-on nodes before it is told to try again */
const CATCH_UP_MS = 20_000;

interface Started {
  readonly node: P2PNode;
  /** The spaces it was given */
  readonly spaces: ReadonlyArray<string>;
  /** Those it has been level with an always-on node in since it started */
  readonly level: Set<string>;
  stop(): Promise<void>;
}

/**
 * Waits until the node has been level with an always-on node in each space it
 * was given: nothing in flight either way. A node starts from an empty folder,
 * and until then it would answer "no such record" for one it hasn't synced
 * yet, and write a first version in a line that has one: a twin, which ends
 * that line for good (09 §7.5: sync before writing to a line). Once level, it
 * stays in sync as any device does.
 */
async function catchUp(started: Started): Promise<void> {
  const deadline = Date.now() + CATCH_UP_MS;
  const levelIn = async (space: string) => {
    while (!started.level.has(space)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const peers = await started.node.spaces.status(space).then(
        (status) => status.peers,
        () => [],
      );
      for (const peer of peers) {
        if (!(await started.node.spaces.reached(space, peer, Math.min(2000, left)).catch(() => false)))
          continue;
        started.level.add(space);
        break;
      }
      if (!started.level.has(space)) await new Promise((resolve) => setTimeout(resolve, Math.min(250, left)));
    }
    return true;
  };
  const all = await Promise.all(started.spaces.map(levelIn));
  if (!all.every(Boolean))
    throw new Error('Still fetching these spaces from the always-on nodes. Try again in a moment.');
}

interface Running {
  readonly started: Promise<Started>;
  timer?: ReturnType<typeof setTimeout>;
  /** Calls running on it now: it isn't stopped under them */
  busy: number;
}

export interface Sessions {
  /**
   * Runs `work` on the node for session `id`, started from `granted` if it
   * isn't running. One node per session, ever: two signing with one key
   * would fork its line.
   */
  use<T>(id: string, granted: Granted, work: (node: P2PNode) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createSessions(options: {
  /** A folder of stores for a session's node, made when it starts */
  readonly stores: (id: string) => StoreFactory;
  /** Removes that folder, once its node has stopped */
  readonly drop: (id: string) => Promise<void>;
  /** How a node reaches the spaces it was given */
  readonly network: () => NodeConfig['network'];
  /** Told once a session's key was revoked in some space: the person disconnected the app */
  readonly onRevoked?: (id: string) => void;
  readonly idleMs?: number;
  readonly running?: number;
  readonly log?: (line: string) => void;
}): Sessions {
  const log = options.log ?? (() => {});
  /** Nodes running, the one used last at the end */
  const running = new Map<string, Running>();
  /** Nodes stopping: one starts again on the same folder only once it has */
  const stopping = new Map<string, Promise<void>>();
  /** Nodes given room to run: started or starting, never more than the cap */
  const granted = new Set<string>();

  const stop = async (id: string) => {
    const one = running.get(id);
    if (!one) return stopping.get(id);
    running.delete(id);
    clearTimeout(one.timer);
    const stopped = (async () => {
      await one.started.then((started) => started.stop()).catch(() => {});
      await options
        .drop(id)
        .catch((error: unknown) => log(`session: could not remove its spaces: ${messageOf(error)}`));
    })();
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
      if (one.busy === 0) void stop(id);
      else idleLater(id);
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
      stores: options.stores(id),
      network: { ...options.network(), only: true },
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
      level: new Set(),
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
    async use(id, given, work) {
      if (!noteRunning(given.grant)) throw new Error('This connection has run out. Connect again.');
      const one = nodeOf(id, given);
      one.busy += 1;
      try {
        const started = await one.started;
        await catchUp(started);
        return await work(started.node);
      } finally {
        one.busy -= 1;
        idleLater(id);
      }
    },
    async close() {
      await Promise.all([...running.keys()].map(stop));
    },
  };
}
