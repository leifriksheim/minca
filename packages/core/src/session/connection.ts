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
  type SeededAppKey,
  type KeptGrant,
  type Proposed,
} from './connect.js';
import type { AutomationProposal } from '../space/own-automations.js';
import { accountHomeLink } from './account-hint.js';
import { popupFeatures } from './popup.js';
import { WORKER_NOT_STARTED, type WorkerLike } from '../node/worker.js';
import { defaultStorage, guardedStorage, type KeyValueStore } from './stay-signed-in.js';
import { markStep } from '../utils/step.js';

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
    get(name: string): Promise<SeededAppKey>;
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
   * Opens the person's account home in a window of its own, at the account
   * this app acts for: its settings, or a `section` of them such as
   * `notifications`. The home is never framed, since it holds the keys. Call
   * it from a click.
   */
  openHome(section?: string): void;
  /**
   * Keeps this tab's node open while the tab is put away, as a call must;
   * returns what lets it go. Otherwise a tab whose node is its own closes it
   * when put away, and opens it again on coming back.
   */
  keepAwake(): () => void;
  /**
   * Offers the person automations that notify them — "notify me when…" — once connected.
   * Opens the home; call it from a click.
   * @returns What they kept
   */
  propose(automations: ReadonlyArray<AutomationProposal>): Promise<Proposed>;
}

const accountsOf = (kept: ReadonlyArray<KeptGrant>): ReadonlyArray<ConnectedAccount> =>
  kept.map(({ grant }) => Object.freeze({ did: grant.did, name: grant.name, expiresAt: grant.expiresAt }));

/**
 * Opens the account home in a window of its own, at the account a connection
 * acts for: `connection.openHome`, for a connection made some other way.
 */
export function openAccountHome(
  {
    home,
    grant,
  }: { readonly home: string; readonly grant: { readonly home: string; readonly did: string } | null },
  section?: string,
): void {
  const link = accountHomeLink(grant?.home ?? home, grant?.did ?? null, section);
  globalThis.open(link, 'minca-account', popupFeatures(720, 820));
}

const ANOTHER_TAB =
  'Minca is open in another tab or window. It carries on here once that one is put away or closed.';

/** Said when opening the account takes far longer than it should: nothing has failed, but something waits */
const SLOW_START =
  'Opening your account is taking longer than it should. If Minca is open in other tabs, closing them may help; reloading this page starts again.';
/** How long opening may take before that is said */
const SLOW_START_MS = 10_000;

/** Whether the page is out of view: put away, or being left */
const hidden = () => globalThis.document?.visibilityState === 'hidden';

/** Settles once the page is in view (at once without a document) */
function inView(): Promise<void> {
  const page = globalThis.document;
  if (!page || page.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (page.visibilityState === 'hidden') return;
      page.removeEventListener('visibilitychange', check);
      resolve();
    };
    page.addEventListener('visibilitychange', check);
  });
}

/** Holds a Web Lock, once granted, until the returned function lets go (nothing to hold without Web Locks) */
function holdLock(name: string): Promise<() => void> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((granted) => {
    locks
      .request(name, () => new Promise<void>((letGo) => granted(() => letGo())))
      .catch(() => granted(() => {}));
  });
}

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

  /**
   * The node this tab runs itself (a dedicated worker's, or the page's), and
   * the turn it holds. Two such nodes on one site's stores get in each
   * other's way, and a browser that freezes background tabs (an iPhone's)
   * would freeze one holding the stores: so one runs at a time per account,
   * in the tab in view, and it closes when the tab is put away.
   */
  let ownTurn: { readonly kept: KeptGrant; readonly release: () => void } | null = null;
  /**
   * The grant this tab closed its node for when put away, to open again on
   * coming back: cleared by anything else that opens or stops, and checked
   * against the grants then, so it never opens what was since replaced.
   */
  let putAway: KeptGrant | null = null;
  /** How many keep the node running while the tab is put away (`keepAwake`), as a call must */
  let awake = 0;

  /** Stops acting for the account acted for, if any, saying in the same breath what comes next */
  async function stop(next: Partial<MincaConnectionState>): Promise<void> {
    unwatch?.();
    unwatch = null;
    putAway = null;
    const node = state.node;
    const turn = ownTurn;
    ownTurn = null;
    update({ ...next, node: null });
    // Its turn goes once its stores are closed, not before.
    await node?.close().finally(() => turn?.release());
  }

  function followVisibility(): void {
    if (hidden()) {
      // Whatever its status: an expired tab's node holds the stores, and its turn, all the same.
      if (!ownTurn || awake > 0) return;
      markStep('connection: put away, closing the node');
      const kept = ownTurn.kept;
      void stop({ status: state.status === 'expired' ? 'expired' : 'starting' });
      putAway = kept;
      return;
    }
    const back = putAway;
    putAway = null;
    // Only the grant still kept for that account, to the same key: another tab may have let it go or renewed it.
    const still = back && grants.get(back.grant.did);
    if (back && still?.keyName === back.keyName) {
      markStep('connection: back, opening the node again');
      void open(still).catch(failed);
    }
  }
  globalThis.document?.addEventListener('visibilitychange', followVisibility);
  // Left (reloaded, closed, or kept frozen to come back to): closed now, for the next page's turn.
  globalThis.addEventListener?.('pagehide', followVisibility);
  globalThis.addEventListener?.('pageshow', followVisibility);

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
      error: `Your account couldn't be opened here: ${error instanceof Error ? error.message : String(error)}`,
    });

  /** Counts opens, so one overtaken by a later one closes what it started */
  let opening = 0;

  async function open({ grant, keyName }: KeptGrant): Promise<void> {
    const mine = ++opening;
    // A grant that ran out starts nothing: connecting again renews it, with a new key.
    const late = grantExpired(grant);
    await stop({ status: late ? 'expired' : 'starting', home: grant.home, grant, error: null });
    kept.set(LAST, grant.did);
    markStep(`connection: starting the account kept here${late ? ', whose grant ran out' : ''}`);
    if (late) return;
    const key = await keys.get(keyName);
    markStep('connection: app key ready, starting the node');
    const start = (worker?: () => WorkerLike) =>
      startConnectedNode({
        grant,
        key,
        ...(config.network ? { network: config.network } : {}),
        ...(config.stores ? { stores: config.stores(grant) } : {}),
        ...(worker ? { worker } : {}),
      });
    const made = config.worker?.();
    // A dedicated worker's node is this tab's own; a shared worker's, every tab's.
    let release: (() => void) | null = null;
    const takeTurn = async (): Promise<() => void> => {
      await inView();
      markStep('connection: waiting for any other tab to close its node');
      // Said only if it takes a while: another tab or window in view has it.
      const slow = setTimeout(() => update({ error: ANOTHER_TAB }), 5000);
      const letGo = await holdLock(`minca-node:${grant.did}`);
      clearTimeout(slow);
      if (state.error === ANOTHER_TAB) update({ error: null });
      return letGo;
    };
    let node: P2PNode;
    // Nothing failed, but the person should hear that something waits, and what to try.
    const slow = setTimeout(() => {
      if (mine === opening && state.status === 'starting' && !state.error) update({ error: SLOW_START });
    }, SLOW_START_MS);
    try {
      if (!made || typeof made.terminate === 'function') release = await takeTurn();
      // A browser whose worker never starts still gets a node, in the page. A
      // worker that started and refused says why instead.
      node = made
        ? await start(() => made).catch(async (error: unknown) => {
            if (!(error instanceof Error) || error.name !== WORKER_NOT_STARTED) throw error;
            markStep('connection: the node’s worker did not start; starting the node in the page');
            release ??= await takeTurn();
            return start();
          })
        : await start();
    } catch (error) {
      release?.();
      throw error;
    } finally {
      clearTimeout(slow);
    }
    const turn = release;
    // Switched again while this one started: it is not wanted.
    if (mine !== opening) {
      await node.close().finally(() => turn?.());
      return;
    }
    markStep('connection: ready');
    ownTurn = turn ? { kept: { grant, keyName }, release: turn } : null;
    update({ status: 'ready', home: grant.home, grant, node, error: null });
    // Opened in a tab put away meanwhile.
    followVisibility();

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

    openHome: (section) => openAccountHome(state, section),

    keepAwake() {
      awake++;
      let kept = true;
      return () => {
        if (!kept) return;
        kept = false;
        awake--;
        followVisibility();
      };
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
