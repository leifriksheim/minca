/**
 * What a chat app acts with, and the node it acts through. The key and the
 * records-only note a person's account home signed are kept by the service,
 * sealed under a key only the app's access token carries (`oauth.ts`). Each
 * call opens them, and the node they start runs while the app is using it,
 * holding its spaces in memory. A write is done once the space's carriers have
 * it. What outlives the node is only where its key has signed (`places`): a
 * key that outlives its node must keep that, or the next would fork it.
 */
import { didOf, noteSpaces, type NodeConfig, type P2PNode, type StoreFactory } from '@minca/core';
import { checkGrant, usableGrant, type Grant } from '@minca/core/session';
import { holdEverySpace, startGrantedAgent } from '../agent.js';
import { catchUp } from '../level.js';
import { isRecord, messageOf } from '../json.js';
import { importKeyJwk } from '../writer-keys.js';
import { boundedMemory } from './memory.js';

/** What a token opens: a key, and the note made out to it */
export interface Granted {
  /** The key the note is made out to, as JWK */
  readonly key: { readonly privateKey: JsonWebKey; readonly publicKey: JsonWebKey };
  readonly grant: Grant;
}

/** Most spaces one connection may be given by name: each, with its keys, travels in the token */
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
 * running. Either for some spaces, given by invite, or for every space, with
 * the account key that follows them; never the contact key, which opens the
 * account's knocks. What the grant says of itself must match its note.
 * @throws When it isn't, saying what to do about it
 */
export async function checkGranted(key: unknown, grant: unknown): Promise<Granted> {
  if (!isKeyJwk(key)) throw new Error('The page sent no key. Start again from the chat app.');
  const keys = await importKeyJwk(key);
  if (!keys) throw new Error('The page sent a key this service can’t read. Start again from the chat app.');
  if (!(await holdsTogether(keys)))
    throw new Error('The page sent a key whose halves don’t match. Start again from the chat app.');
  if (!isRecord(grant)) throw new Error('Your account home sent no grant. Try connecting again.');
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant checks it, and usableGrant its version and time
  const checked = grant as unknown as Grant;
  await checkGrant(checked, await didOf(keys.publicKey), { recordsOnly: true });
  if (!usableGrant(checked) || !noteRunning(checked))
    throw new Error(
      'That grant has run out, or comes from an account home this service can’t read. Update your home, or connect again.',
    );
  if (checked.contactKey !== undefined)
    throw new Error('A chat app here is never given your contacts. Connect again, and don’t give it them.');
  const reach = noteSpaces(checked.note);
  if (checked.scope === 'account') {
    if (reach !== 'all' || checked.accountKey === undefined)
      throw new Error('That grant says every space, but its note doesn’t. Connect again.');
  } else {
    if (reach === 'all' || checked.accountKey !== undefined || checked.scope !== 'spaces')
      throw new Error('That grant says some spaces, but its note is for every one. Connect again.');
    if (checked.spaces.length > MAX_SPACES)
      throw new Error(
        `Pick at most ${MAX_SPACES} spaces, or give it every space: picked ones travel in the chat app’s sign-in.`,
      );
  }
  return { key, grant: checked };
}

/** How long a node stays up after its last call */
const IDLE_MS = 10 * 60_000;
/** Nodes running at once: a start past it waits for one to stop */
const RUNNING = 32;
/** How long a start waits for room before giving up */
const ROOM_WAIT_MS = 30_000;

interface Started {
  readonly node: P2PNode;
  /** The spaces calls have worked in: only these are open, and only these can hold writes not kept yet */
  readonly used: Set<string>;
  stop(): Promise<void>;
}

/** How long an idle node stays up for its writes the space's carriers don't have yet */
const UNKEPT_MS = 60 * 60_000;

/** Whether a node wrote something a space's carriers don't have yet: stopped, it would be lost */
async function unkept(started: Started): Promise<boolean> {
  for (const space of started.used)
    if ((await started.node.spaces.status(space).catch(() => null))?.pending) return true;
  return false;
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
        // Its writes the carriers don't have yet would go with it: it waits for them, for a while.
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
  function storesFor(given: Granted): StoreFactory {
    const memory = boundedMemory(options.budget);
    const places = options.places?.(given.grant.note.payload.aud);
    return (where, storeOptions) => (where === 'writers' && places ? places : memory)(where, storeOptions);
  }

  async function start(id: string, given: Granted): Promise<Started> {
    const keys = await importKeyJwk(given.key);
    if (!keys) throw new Error('The key could not be read');
    // Reaching only what it was given: what it reads, and the invites in its grant, are the account's to write.
    const agent = await startGrantedAgent({
      grant: given.grant,
      keys,
      // In memory: what it holds is the always-on nodes', and goes when it stops.
      stores: storesFor(given),
      network: await options.network(given.grant),
      // What it holds goes when it stops: each record as it is now, not every edit it ever had.
      shallow: true,
    });
    // Disconnected at the account home: it reads and writes no more, from now on.
    const unsubscribe = agent.node.subscribe((event) => {
      if (event.type !== 'revoked') return;
      options.onRevoked?.(id);
      void stop(id);
    });
    // Given some spaces, at most a few, it holds them from the start, so it hears a revoke there before any call.
    // Given every space it holds the account's list, where a revoke reaches it too, and opens spaces as calls name them.
    const picked = given.grant.scope === 'spaces';
    const used = new Set<string>(picked ? given.grant.spaces.map((space) => space.id) : []);
    const stopHolding = picked ? await holdEverySpace(agent.node) : () => {};
    return {
      node: agent.node,
      used,
      stop: async () => {
        stopHolding();
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
        const started = await one.started.catch((error: unknown) => {
          throw new Error(
            `Couldn’t open this account’s spaces: ${messageOf(error)} If it keeps happening, connect the chat app again.`,
          );
        });
        // A node starts from nothing: one that answered sooner would say a record isn't
        // there, and write a first version in a line that has one, which ends it (09 §7.5).
        // Checked on every call, since a link that drops leaves it behind again.
        if (space !== undefined) {
          await catchUp(started.node, space);
          // Opened by the first call that names it, and counted once it is a space here: none a caller merely names.
          started.used.add(space);
        }
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
