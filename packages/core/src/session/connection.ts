/**
 * @module session/connection
 * An app's side of an account home, as one object any UI can draw — the twin
 * of `createMincaAuth`, for apps that never sign anyone in themselves.
 *
 * ```ts
 * const connection = createMincaConnection({
 *   home: 'https://minca-home.example/connect',   // a default; people can bring their own
 *   request: { name: 'Todo', access: 'write', scope: 'account' },
 *   network: { relays },
 * });
 * button.onclick = () => connection.connect();   // from a click: it opens a popup
 * connection.subscribe(({ status, node }) => …);
 * ```
 *
 * It remembers the grant between visits and starts the node from it; when the
 * grant runs out it says so (`expired`), and connecting again renews it. When
 * the home disconnects the app, it forgets the grant and says so.
 *
 * It keeps a grant for each account the person connects, each made out to a
 * key of its own, and acts for one at a time: `use(did)` switches, with no
 * trip to the home, since the grant is already here. It learns of an account
 * only when the person connects it.
 *
 * The home is the person's, not the app's: `home` is only a default.
 * `connect('minca.example.com')` uses theirs, and it is remembered — for
 * reconnecting, and for linking to their account settings.
 */
import type { NodeNetworkConfig, P2PNode } from '../node/types.js';
import type { StoreFactory } from '../node/stores.js';
import {
  appKey,
  connectToHome,
  homeAddress,
  forgetAppKey,
  grantStore,
  proposeToHome,
  startConnectedNode,
  watchGrant,
  grantExpired,
  type ConnectRequest,
  type Grant,
  type AppKey,
  type KeptGrant,
  type Proposed,
} from './connect.js';
import type { AutomationProposal } from '../space/own-automations.js';
import { WORKER_NOT_STARTED, type WorkerLike } from '../node/worker.js';
import { defaultStorage, guardedStorage, type KeyValueStore } from './stay-signed-in.js';

export interface MincaConnectionConfig {
  /** The account home to suggest — the person can use their own instead */
  readonly home: string;
  /** What to ask for */
  readonly request: Omit<ConnectRequest, 'v' | 'audience' | 'proof'>;
  /** Relays and always-on nodes the node connects to. Omit to stay offline. */
  readonly network?: NodeNetworkConfig;
  /** Where the grants are kept. Default `localStorage`. */
  readonly storage?: KeyValueStore | null;
  /** Where the node keeps its data. Default: this site's IndexedDB. */
  readonly stores?: (grant: Grant) => StoreFactory;
  /**
   * Runs the node in a worker, off the page's main thread
   * (`@minca/core/node-worker`). Called each time the node starts;
   * the worker ends when it closes. Not with `stores`.
   */
  readonly worker?: () => WorkerLike;
  /** Where the app's keys are kept, one per account, by name. Default: this site's IndexedDB (`appKey`). */
  readonly keys?: {
    get(name: string): Promise<AppKey>;
    forget(name: string): Promise<void>;
  };
  /**
   * Which connected account to act for on starting, such as the one the
   * address names. Default: the one used last here, else the first.
   */
  readonly account?: (accounts: ReadonlyArray<ConnectedAccount>) => string | null | undefined;
}

/**
 * `starting` — looking for a grant from an earlier visit, or switching account.
 * `disconnected` — none; show a way to connect. `error` says why, when the home disconnected the app.
 * `connecting` — the home is open, waiting on the person.
 * `ready` — `node` acts for the account.
 * `expired` — the grant ran out; connecting again renews it.
 */
export type ConnectionStatus = 'starting' | 'disconnected' | 'connecting' | 'ready' | 'expired';

/** An account this app holds a grant for */
export interface ConnectedAccount {
  readonly did: string;
  /** The name the home gave when it granted, for showing which is which */
  readonly name: string;
  /** When its grant runs out, in seconds since the epoch */
  readonly expiresAt: number;
}

export interface MincaConnectionState {
  readonly status: ConnectionStatus;
  /** The home this app connects to: the person's own, once they chose one, else the default */
  readonly home: string;
  /** The grant of the account acted for */
  readonly grant: Grant | null;
  readonly node: P2PNode | null;
  readonly error: string | null;
  /** Every account connected here, in the order they were first connected */
  readonly accounts: ReadonlyArray<ConnectedAccount>;
}

export interface MincaConnection {
  getState(): MincaConnectionState;
  subscribe(listener: (state: MincaConnectionState) => void): () => void;
  /** Picks up a grant from an earlier visit. Safe to call more than once. */
  start(): Promise<void>;
  /**
   * Opens the home and asks, with a new key. Call it from a click. Acts for
   * whichever account the person chooses there: a new one, or one connected
   * already, whose grant this renews.
   * @param home The person's own home — `minca.example.com` is enough. Default: the one in `state.home`.
   */
  connect(home?: string): Promise<void>;
  /** Acts for another connected account. The home is not asked: its grant is here already. */
  use(did: string): Promise<void>;
  /**
   * Forgets an account's grant and its key (default the one acted for), and
   * acts for the next connected account, if any. The account is untouched.
   */
  disconnect(did?: string): Promise<void>;
  /**
   * Offers the person automations that notify them — "notify me when…" — once connected.
   * Opens the home; call it from a click.
   * @returns What they kept
   */
  propose(automations: ReadonlyArray<AutomationProposal>): Promise<Proposed>;
}

const accountsOf = (kept: ReadonlyArray<KeptGrant>): ReadonlyArray<ConnectedAccount> =>
  kept.map(({ grant }) => Object.freeze({ did: grant.did, name: grant.name, expiresAt: grant.expiresAt }));

export function createMincaConnection(config: MincaConnectionConfig): MincaConnection {
  const storage = defaultStorage(config.storage);
  const grants = grantStore(storage);
  const kept = guardedStorage(storage);
  const HOME = 'minca.home';
  const LAST = 'minca.account';
  const rememberedHome = kept.get(HOME);
  const keys = config.keys ?? { get: appKey, forget: forgetAppKey };

  let state: MincaConnectionState = Object.freeze({
    status: 'starting',
    home: rememberedHome ?? homeAddress(config.home),
    grant: null,
    node: null,
    error: null,
    accounts: accountsOf(grants.list()),
  });
  const listeners = new Set<(state: MincaConnectionState) => void>();
  const update = (patch: Partial<MincaConnectionState>) => {
    state = Object.freeze({ ...state, accounts: accountsOf(grants.list()), ...patch });
    for (const listener of listeners) listener(state);
  };

  // An account connected or let go in another tab shows in this one's list.
  globalThis.addEventListener?.('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === 'minca.grants') update({});
  });

  let started: Promise<void> | null = null;
  let unwatch: (() => void) | null = null;

  /** Stops acting for the account acted for, if any, saying in the same breath what comes next */
  async function stop(next: Partial<MincaConnectionState>): Promise<void> {
    unwatch?.();
    unwatch = null;
    const node = state.node;
    update({ ...next, node: null });
    await node?.close();
  }

  /**
   * Forgets an account. Let go here, it acts for the next one, or for none;
   * disconnected at the home (`error`), for none, rather than another account
   * unasked. With `keyName`, only the grant to that key: another tab may have
   * connected the account again meanwhile, and its newer grant stays, for
   * this tab to take up.
   */
  async function leave(did: string, error: string | null, keyName?: string): Promise<void> {
    const now = grants.get(did);
    const replaced = keyName !== undefined && now !== null && now.keyName !== keyName;
    if (!replaced) grants.forget(did);
    if (state.grant?.did === did) {
      const next = replaced ? now : error ? null : grants.list()[0];
      if (next) {
        await open(next).catch(failed);
        if (error && !replaced) update({ error });
      } else await stop({ status: 'disconnected', grant: null, error });
    } else update({});
    if (now && !replaced) await keys.forget(now.keyName).catch(() => {});
  }

  const failed = (error: unknown) =>
    update({
      status: 'disconnected',
      grant: null,
      error: error instanceof Error ? error.message : String(error),
    });

  /** Counts opens, so one overtaken by a later one closes what it started */
  let opening = 0;

  async function open({ grant, keyName }: KeptGrant): Promise<void> {
    const mine = ++opening;
    // A grant that ran out starts nothing: connecting again renews it, with a new key.
    const late = grantExpired(grant);
    await stop({ status: late ? 'expired' : 'starting', home: grant.home, grant, error: null });
    kept.set(LAST, grant.did);
    if (late) return;
    const key = await keys.get(keyName);
    const start = (worker?: () => WorkerLike) =>
      startConnectedNode({
        grant,
        key,
        ...(config.network ? { network: config.network } : {}),
        ...(config.stores ? { stores: config.stores(grant) } : {}),
        ...(worker ? { worker } : {}),
      });
    // A browser whose worker never starts still gets a node, in the page. A
    // worker that started and refused says why instead.
    const node = config.worker
      ? await start(config.worker).catch((error: unknown) => {
          if (error instanceof Error && error.name === WORKER_NOT_STARTED) return start();
          throw error;
        })
      : await start();
    // Switched again while this one started: it is not wanted.
    if (mine !== opening) {
      await node.close();
      return;
    }
    update({ status: 'ready', home: grant.home, grant, node, error: null });

    unwatch = watchGrant(node, grant, {
      // Writes stop working when the note runs out; say so rather than fail quietly.
      onExpired: () => update({ status: 'expired' }),
      // The home disconnected this app: nothing it writes counts any more, so stop.
      onRevoked: () =>
        state.node === node &&
        void leave(grant.did, `Your account home disconnected this app from ${grant.name}.`, keyName),
    });
  }

  const connection: MincaConnection = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      started ??= (async () => {
        const all = grants.list();
        const wanted = config.account?.(accountsOf(all)) ?? kept.get(LAST);
        const first = all.find((each) => each.grant.did === wanted) ?? all[0];
        if (!first) {
          update({ status: 'disconnected' });
          return;
        }
        await open(first).catch(failed);
      })();
      return started;
    },

    async connect(home) {
      const was = state.status;
      let address: string;
      try {
        address = home === undefined ? state.home : homeAddress(home);
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // A new key each time, whichever account the person chooses at the home: a key that
      // asked once may hold a note from any account the home was signed in as.
      const keyName = `account-${globalThis.crypto.randomUUID()}`;
      // An app acting for an account goes on doing so while the person adds another.
      if (was !== 'ready') update({ status: 'connecting', error: null });
      else update({ error: null });
      let grant: Grant;
      try {
        // Nothing awaited before this: the popup must open inside the click.
        grant = await connectToHome({ home: address, request: config.request, key: keys.get(keyName) });
      } catch (error) {
        await keys.forget(keyName).catch(() => {});
        update({
          status: was === 'expired' || was === 'ready' ? was : 'disconnected',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const before = grants.get(grant.did);
      grants.save(grant, keyName);
      kept.set(HOME, address);
      update({ home: address });
      // The grant is kept even if its node won't start now: starting again, or `use`, tries again.
      await open({ grant, keyName }).catch(failed);
      // The key it replaced is no use to this app now. The home keeps it, to revoke if the person disconnects.
      if (before && before.keyName !== keyName) await keys.forget(before.keyName).catch(() => {});
    },

    async use(did) {
      if (state.grant?.did === did && state.status !== 'disconnected') return;
      const found = grants.get(did);
      if (!found) throw new Error('This app isn’t connected to that account. Connect it first.');
      await open(found).catch(failed);
    },

    async disconnect(did) {
      const target = did ?? state.grant?.did;
      if (target) await leave(target, null);
    },

    async propose(automations) {
      if (!state.grant) throw new Error('Connect to your account home first.');
      const answer = await proposeToHome({
        home: state.grant.home,
        automations,
        ...(config.request.name ? { name: config.request.name } : {}),
      });
      // The home's window closes now: take what it wrote rather than wait to meet it over the network.
      if (Array.isArray(answer.versions) && answer.versions.length > 0)
        await state.node?.automations.take(answer.versions).catch(() => 0);
      return answer;
    },
  };

  return connection;
}
