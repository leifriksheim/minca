/**
 * The agents a host runs for chat apps people connected to their account
 * (`remote-mcp/index.ts`): one for each time someone allowed one, under a key
 * the person's browser made and handed over with the records-only note their
 * account home signed for it. The key is the host's to hold from then on, as
 * a hosted bot's is, so the host can read what that agent may read.
 *
 * An agent's node starts when its first call comes and stops after a while
 * with none, so a host holds open only the agents people are using. Its
 * spaces stay in the host's stores between starts, so it starts from what it
 * synced last time.
 */
import { didOf, type NodeConfig, type P2PNode, type StorageAdapter, type StoreFactory } from '@minca/core';
import { checkGrant, usableGrant, type Grant } from '@minca/core/session';
import { holdEverySpace, startGrantedAgent } from '../agent.js';
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
  /** Unix seconds */
  readonly createdAt: number;
  /** Set once the account revoked the key in some space: a revoked key never writes again */
  readonly revoked?: boolean;
}

export interface Connections {
  /**
   * Keeps a new connection, once its grant checks out: a records-only note,
   * signed by the account, made out to this key, not run out.
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
  /** The connection's agent node, started if it isn't */
  node(id: string): Promise<P2PNode>;
  forget(id: string): Promise<void>;
  close(): Promise<void>;
}

const PREFIX = 'connection:';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** How long an agent's node stays up after its last call */
const IDLE_MS = 10 * 60_000;

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

export function createConnections(options: {
  /** Where connections are kept */
  readonly store: StorageAdapter;
  /** Where each agent's node keeps its spaces, by connection */
  readonly stores: (id: string) => StoreFactory;
  /** How an agent's node reaches its spaces: the host's own socket, or a test's hub */
  readonly network: () => NodeConfig['network'];
  readonly idleMs?: number;
  readonly log?: (line: string) => void;
}): Connections {
  const log = options.log ?? (() => {});
  const running = new Map<
    string,
    {
      readonly started: Promise<{ node: P2PNode; stop(): Promise<void> }>;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

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

  const stop = async (id: string) => {
    const one = running.get(id);
    if (!one) return;
    running.delete(id);
    clearTimeout(one.timer);
    await one.started.then((started) => started.stop()).catch(() => {});
  };

  const idleLater = (id: string) => {
    const one = running.get(id);
    if (!one) return;
    clearTimeout(one.timer);
    one.timer = setTimeout(() => void stop(id), options.idleMs ?? IDLE_MS);
    one.timer.unref?.();
  };

  async function start(connection: Connection) {
    const keys = await importKeyJwk(connection.key);
    if (!keys) throw new Error('The connection’s key could not be read');
    const { grant } = connection;
    const agent = await startGrantedAgent({
      grant,
      keys,
      stores: options.stores(connection.id),
      network: options.network(),
    });
    const stopHolding = await holdEverySpace(agent.node, {
      log: (line) => log(`connector ${connection.id}: ${line}`),
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
        stopHolding();
        await agent.stop();
      },
    };
  }

  return {
    async add(params) {
      if (!isKeyJwk(params.key)) throw new Error('That is not a key pair');
      const keys = await importKeyJwk(params.key);
      if (!keys) throw new Error('That is not a key pair');
      if (!isRecord(params.grant)) throw new Error('That is not a grant');
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant checks it, and usableGrant its version and time
      const grant = params.grant as unknown as Grant;
      await checkGrant(grant, await didOf(keys.publicKey), { recordsOnly: true });
      if (!usableGrant(grant)) throw new Error('That grant has run out, or is of a version no peer reads');
      const connection: Connection = {
        id: randomId(),
        key: params.key,
        grant,
        client: params.client.slice(0, 120),
        createdAt: Math.floor(Date.now() / 1000),
      };
      await write(connection);
      return connection;
    },

    get: read,

    async usable(id) {
      const connection = await read(id);
      return !!connection && !connection.revoked && usableGrant(connection.grant);
    },

    async node(id) {
      let one = running.get(id);
      if (!one) {
        const connection = await read(id);
        if (!connection || connection.revoked || !usableGrant(connection.grant))
          throw new Error('This connection can no longer act for the account. Connect again.');
        const started = start(connection);
        one = { started };
        running.set(id, one);
        started.catch((error: unknown) => {
          log(`connector ${id}: could not start: ${messageOf(error)}`);
          if (running.get(id) === one) running.delete(id);
        });
      }
      idleLater(id);
      return (await one.started).node;
    },

    async forget(id) {
      await stop(id);
      await options.store.delete(`${PREFIX}${id}`);
    },

    async close() {
      await Promise.all([...running.keys()].map(stop));
    },
  };
}

/** 128 random bits, base64url: a connection's id, which names the account an access token acts for */
function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString('base64url');
}
