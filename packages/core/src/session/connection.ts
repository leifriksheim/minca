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
  type ConnectRequest,
  type Grant,
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
  /** Where the grant is kept. Default `localStorage`. */
  readonly storage?: KeyValueStore | null;
  /** Where the node keeps its data. Default: this site's IndexedDB. */
  readonly stores?: (grant: Grant) => StoreFactory;
  /**
   * Runs the node in a worker, off the page's main thread
   * (`@minca/core/node-worker`). Called each time the node starts;
   * the worker ends when it closes. Not with `stores`.
   */
  readonly worker?: () => WorkerLike;
}

/**
 * `starting` — looking for a grant from an earlier visit.
 * `disconnected` — none; show a way to connect. `error` says why, when the home disconnected the app.
 * `connecting` — the home is open, waiting on the person.
 * `ready` — `node` acts for the account.
 * `expired` — the grant ran out; connecting again renews it.
 */
export type ConnectionStatus = 'starting' | 'disconnected' | 'connecting' | 'ready' | 'expired';

export interface MincaConnectionState {
  readonly status: ConnectionStatus;
  /** The home this app connects to: the person's own, once they chose one, else the default */
  readonly home: string;
  readonly grant: Grant | null;
  readonly node: P2PNode | null;
  readonly error: string | null;
}

export interface MincaConnection {
  getState(): MincaConnectionState;
  subscribe(listener: (state: MincaConnectionState) => void): () => void;
  /** Picks up a grant from an earlier visit. Safe to call more than once. */
  start(): Promise<void>;
  /**
   * Opens the home and asks. Call it from a click.
   * @param home The person's own home — `minca.example.com` is enough. Default: the one in `state.home`.
   */
  connect(home?: string): Promise<void>;
  /** Forgets the grant and this app's key, and stops the node. The account is untouched. */
  disconnect(): Promise<void>;
  /**
   * Offers the person automations that notify them — "notify me when…" — once connected.
   * Opens the home; call it from a click.
   * @returns What they kept
   */
  propose(automations: ReadonlyArray<AutomationProposal>): Promise<Proposed>;
}

export function createMincaConnection(config: MincaConnectionConfig): MincaConnection {
  const storage = defaultStorage(config.storage);
  const grants = grantStore(storage);
  const kept = guardedStorage(storage);
  const HOME = 'minca.home';
  const rememberedHome = kept.get(HOME);

  let state: MincaConnectionState = Object.freeze({
    status: 'starting',
    home: rememberedHome ?? homeAddress(config.home),
    grant: null,
    node: null,
    error: null,
  });
  const listeners = new Set<(state: MincaConnectionState) => void>();
  const update = (patch: Partial<MincaConnectionState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  };

  let started: Promise<void> | null = null;
  let unwatch: (() => void) | null = null;

  /** Forgets the grant and this app's key, and stops the node */
  async function end(error: string | null): Promise<void> {
    unwatch?.();
    unwatch = null;
    grants.forget();
    const node = state.node;
    update({ status: 'disconnected', grant: null, node: null, error });
    await node?.close();
    await forgetAppKey().catch(() => {});
  }

  async function open(grant: Grant): Promise<void> {
    unwatch?.();
    await state.node?.close();
    const key = await appKey();
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
    update({ status: 'ready', home: grant.home, grant, node, error: null });

    unwatch = watchGrant(node, grant, {
      // Writes stop working when the note runs out; say so rather than fail quietly.
      onExpired: () => update({ status: 'expired' }),
      // The home disconnected this app: nothing it writes counts any more, so stop.
      onRevoked: () => state.node === node && void end('Your account home disconnected this app.'),
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
        const grant = grants.load();
        if (!grant) {
          update({ status: 'disconnected' });
          return;
        }
        try {
          await open(grant);
        } catch (error) {
          update({ status: 'disconnected', error: error instanceof Error ? error.message : String(error) });
        }
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
      update({ status: 'connecting', error: null });
      try {
        // Nothing awaited before this: the popup must open inside the click.
        const grant = await connectToHome({ home: address, request: config.request });
        grants.save(grant);
        kept.set(HOME, address);
        update({ home: address });
        await open(grant);
      } catch (error) {
        update({
          status: was === 'expired' || was === 'ready' ? was : 'disconnected',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    disconnect: () => end(null),

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
