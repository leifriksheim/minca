/**
 * The agents a host runs for chat apps people connected to their account
 * (`remote-mcp/index.ts`): one for each time someone allowed one, under a key
 * the person's browser made and handed over with the records-only note their
 * account home signed for it. The key is the host's to hold from then on, as
 * a hosted bot's is, so the host can read what that agent may read.
 *
 * An agent's node starts when its first call comes and stops after a while
 * with none, so a host holds open only the agents people are using, and only
 * so many at once. Its spaces stay in the host's stores between starts, so it
 * starts from what it synced last time.
 *
 * Only accounts the host names may connect (`accounts`): each connection is
 * a key, a copy of the spaces it was given and, while used, a node, none of
 * which any account's room or fund pays for yet, so a host offers them to
 * people it knows, not to anyone who makes an account.
 *
 * A connection goes, key, spaces and all, once it can't act any more: its
 * note run out, or its key revoked, which its agent hears the next time it
 * runs. A revoked key writes nothing any peer takes; one past its note would
 * still count (06 §2.9), so a host doesn't keep it. An account keeps only its
 * newest few.
 */
import {
  didOf,
  noteSpaces,
  type NodeConfig,
  type P2PNode,
  type StorageAdapter,
  type StoreFactory,
} from '@minca/core';
import { checkGrant, usableGrant, type Grant } from '@minca/core/session';
import { startGrantedAgent } from '../agent.js';
import { isRecord, messageOf } from '../json.js';
import { importKeyJwk } from '../writer-keys.js';

/** What a host keeps about one connection */
export interface Connection {
  readonly id: string;
  /** The key the note is made out to, as JWK: the host's to sign with */
  readonly key: { readonly privateKey: JsonWebKey; readonly publicKey: JsonWebKey };
  readonly grant: Grant;
  /** The app the person connected, as it named itself: shown, never trusted */
  readonly client: string;
  /** Unix milliseconds: which of an account's connections is oldest */
  readonly createdAt: number;
  /** Set once the account revoked the key in some space: a revoked key never writes again */
  readonly revoked?: boolean;
}

export interface Connections {
  /**
   * Keeps a new connection, once its grant checks out: a records-only note,
   * signed by the account, made out to this key, not run out. The account's
   * oldest go past its newest few.
   * @throws When it doesn't
   */
  add(params: {
    readonly key: unknown;
    readonly grant: unknown;
    readonly client: string;
  }): Promise<Connection>;
  get(id: string): Promise<Connection | null>;
  /** Whether a connection can still act: there, its note running, its key not revoked */
  usable(id: string): Promise<boolean>;
  /**
   * Runs `work` on the connection's agent node, started if it isn't. One node
   * per connection, ever: two signing with one key would fork its line.
   */
  use<T>(id: string, work: (node: P2PNode) => Promise<T>): Promise<T>;
  /** Forgets a connection: its key, its grant and the spaces its agent kept */
  forget(id: string): Promise<void>;
  /** Forgets every connection that can't act any more */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

const PREFIX = 'connection:';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** How long an agent's node stays up after its last call */
const IDLE_MS = 10 * 60_000;
/** Connections one account keeps here: connecting another forgets its oldest */
const PER_ACCOUNT = 10;
/** Agents running at once: starting another stops the one used longest ago */
const RUNNING = 32;
/** How often connections that can't act any more are forgotten */
const SWEEP_MS = 3600_000;

function isConnection(value: unknown): value is Connection {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRecord(value.key) &&
    isRecord(value.key.privateKey) &&
    isRecord(value.key.publicKey) &&
    isRecord(value.grant) &&
    typeof value.client === 'string' &&
    typeof value.createdAt === 'number'
  );
}

/** A key pair as the browser exported it, both halves JWK */
function isKeyJwk(value: unknown): value is Connection['key'] {
  return isRecord(value) && isRecord(value.privateKey) && isRecord(value.publicKey);
}

/** Whether a grant's note is still running, by the note itself: the grant's own `expiresAt` is the home's word beside it */
function noteRunning(grant: Grant): boolean {
  const exp = grant.note.payload.exp;
  return exp !== undefined && exp > Math.floor(Date.now() / 1000);
}

const usableNow = (connection: Connection) =>
  !connection.revoked && usableGrant(connection.grant) && noteRunning(connection.grant);

/** How long a start waits for room among the agents running before it gives up */
const ROOM_WAIT_MS = 30_000;

interface Running {
  readonly started: Promise<{ node: P2PNode; stop(): Promise<void> }>;
  timer?: ReturnType<typeof setTimeout>;
  /** Calls running on it now: it isn't stopped under them */
  busy: number;
}

export function createConnections(options: {
  /** The accounts that may connect, by DID */
  readonly accounts: ReadonlyArray<string>;
  /** Where connections are kept */
  readonly store: StorageAdapter;
  /** Where each agent's node keeps its spaces, by connection */
  readonly stores: (id: string) => StoreFactory;
  /** Removes what an agent's node kept, once its connection is forgotten */
  readonly drop: (id: string) => Promise<void>;
  /** How an agent's node reaches its spaces: the host's own socket, or a test's hub */
  readonly network: () => NodeConfig['network'];
  readonly idleMs?: number;
  /** Agents running at once. Default 32. */
  readonly running?: number;
  readonly log?: (line: string) => void;
}): Connections {
  const log = options.log ?? (() => {});
  /** Agents running, the one used last at the end */
  const running = new Map<string, Running>();
  /** Agents stopping: one starts again on the same stores only once it has */
  const stopping = new Map<string, Promise<void>>();
  /** Agents given room to run: started or starting. No more than the cap, ever. */
  const granted = new Set<string>();

  const read = async (id: string): Promise<Connection | null> => {
    const bytes = await options.store.get(`${PREFIX}${id}`);
    if (!bytes) return null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return isConnection(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const write = (connection: Connection) =>
    options.store.put(`${PREFIX}${connection.id}`, encode(connection));

  const all = async (): Promise<Connection[]> => {
    const found: Connection[] = [];
    for (const key of await options.store.list(PREFIX)) {
      const connection = await read(key.slice(PREFIX.length));
      if (connection) found.push(connection);
    }
    return found;
  };

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
      if (one.busy === 0) void stop(id);
      else idleLater(id);
    }, options.idleMs ?? IDLE_MS);
    one.timer.unref?.();
  };

  /**
   * Waits for room for `id`'s agent to run: takes a free place, or stops the
   * agent used longest ago with no call running, or waits for one to finish.
   */
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
      else if (Date.now() > giveUp) throw new Error('This host is busy. Try again in a moment.');
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** The connection's agent: running, or started now and marked running before anything is awaited */
  function agentOf(id: string): Running {
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
        const connection = await read(id);
        if (!connection || !usableNow(connection))
          throw new Error('This connection can no longer act for the account. Connect again.');
        return start(connection);
      })(),
    };
    running.set(id, made);
    made.started.catch((error: unknown) => {
      log(`connector ${id}: could not start: ${messageOf(error)}`);
      if (running.get(id) === made) {
        running.delete(id);
        granted.delete(id);
      }
    });
    return made;
  }

  async function forget(id: string) {
    await stop(id);
    await options.store.delete(`${PREFIX}${id}`);
    await options
      .drop(id)
      .catch((error: unknown) => log(`connector ${id}: could not remove its spaces: ${messageOf(error)}`));
  }

  async function sweep() {
    for (const connection of await all()) if (!usableNow(connection)) await forget(connection.id);
  }

  async function start(connection: Connection) {
    const keys = await importKeyJwk(connection.key);
    if (!keys) throw new Error('The connection’s key could not be read');
    // It holds every space it was given, from start to stop.
    const agent = await startGrantedAgent({
      grant: connection.grant,
      keys,
      stores: options.stores(connection.id),
      // Only the host's own socket: a grant's invites, and the records the agent reads, are the
      // account's to fill in, and must not choose where the host connects or what it keeps.
      network: { ...options.network(), only: true },
    });
    const unsubscribe = agent.node.subscribe((event) => {
      if (event.type !== 'revoked') return;
      // The account took this key back somewhere: nothing it writes counts now, so the app connects again.
      void read(connection.id).then(async (now) => {
        if (now && !now.revoked) await write({ ...now, revoked: true });
      });
      log(`connector ${connection.id}: its key was revoked in ${event.space}`);
    });
    return {
      node: agent.node,
      stop: async () => {
        unsubscribe();
        await agent.stop();
      },
    };
  }

  const sweeping = setInterval(
    () => void sweep().catch((error: unknown) => log(`connectors: sweeping failed: ${messageOf(error)}`)),
    SWEEP_MS,
  );
  sweeping.unref();

  return {
    async add(params) {
      if (!isKeyJwk(params.key)) throw new Error('That is not a key pair');
      const keys = await importKeyJwk(params.key);
      if (!keys) throw new Error('That is not a key pair');
      // Its halves belong together: a note is no secret, travelling with every record its key signs,
      // so naming a key takes holding it (as 06 §2.4 asks of a request at the home).
      if (!(await holdsTogether(keys))) throw new Error('That private key is not the public key’s');
      if (!isRecord(params.grant)) throw new Error('That is not a grant');
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant checks it, and usableGrant its version and time
      const grant = params.grant as unknown as Grant;
      const did = await didOf(keys.publicKey);
      await checkGrant(grant, did, { recordsOnly: true });
      if (!usableGrant(grant) || !noteRunning(grant))
        throw new Error('That grant has run out, or is of a version no peer reads');
      // The spaces the person picked, never the whole account: by the note itself, and no account key.
      if (noteSpaces(grant.note) === 'all' || grant.accountKey !== undefined || grant.scope !== 'spaces')
        throw new Error('A chat app here gets the spaces the person picks, not the whole account');
      if (!options.accounts.includes(grant.did))
        throw new Error('This host connects chat apps only for the accounts it names, and not this one.');
      // One key, one connection: two agents signing with it would fork its line.
      if ((await all()).some((one) => one.grant.note.payload.aud === did))
        throw new Error('That key is already connected');
      const connection: Connection = {
        id: randomId(),
        key: params.key,
        grant,
        client: params.client.slice(0, 120),
        createdAt: Date.now(),
      };
      await write(connection);
      // The account's newest few: an app connected again and again doesn't pile up keys here.
      const older = (await all())
        .filter((one) => one.grant.did === grant.did && one.id !== connection.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      for (const old of older.slice(PER_ACCOUNT - 1)) await forget(old.id);
      return connection;
    },

    get: read,

    async usable(id) {
      const connection = await read(id);
      return !!connection && usableNow(connection);
    },

    async use(id, work) {
      const one = agentOf(id);
      one.busy += 1;
      try {
        const { node } = await one.started;
        return await work(node);
      } finally {
        one.busy -= 1;
        idleLater(id);
      }
    },

    forget,
    sweep,

    async close() {
      clearInterval(sweeping);
      await Promise.all([...running.keys()].map(stop));
    },
  };
}

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

/** 128 random bits, base64url: a connection's id, which names the account an access token acts for */
function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString('base64url');
}
