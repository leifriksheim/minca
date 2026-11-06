/**
 * @module node/resumable
 * A node that can let go and come back, as one object: `pause` ends the node
 * under it, `resume` starts another, and whoever holds `node` keeps using
 * the same object throughout. A tab put away does this, so that a browser
 * that freezes background tabs (an iPhone's) never freezes one holding the
 * stores another tab's node is waiting on.
 *
 * While paused, calls wait for the next node. Calls still running when it
 * paused fail, since the node that took them is gone: what it had not
 * finished storing was not stored. Event listeners, watches and holds carry
 * over to each new node.
 */
import { buildNamespaces, callMethod, givenFor, type Namespace } from './api.js';
import type { Query } from '../query/types.js';
import type { CollectionRef, IncludeMap, ResultFor } from '../query/types.js';
import type { NodeEvent, P2PNode } from './types.js';

export interface ResumableNode {
  /** The node to use: the same object, whichever node is under it */
  readonly node: P2PNode;
  /** Ends the node under it at once (`end`), failing what it was doing. Calls from now on wait. */
  pause(): void;
  /** Starts a node again, and lets waiting calls through */
  resume(): Promise<void>;
  /** Whether a node is under it */
  readonly running: boolean;
}

interface Running {
  readonly node: P2PNode;
  /** Ends it now: a worker terminated, rather than asked to close */
  readonly end: () => void;
}

const PUT_AWAY = 'This tab was put away while that was being done; try again';

/**
 * Wraps the node `start` starts. `start` gives the node and how to end it at
 * once; it is called again on each `resume`.
 */
export async function resumableNode(start: () => Promise<Running>): Promise<ResumableNode> {
  let current: Running | null = await start();
  const first = current.node;
  /** The node calls go to, once there is one; replaced on each pause */
  let ready: Promise<P2PNode> = Promise.resolve(first);
  let letThrough: ((node: P2PNode) => void) | null = null;
  let closed = false;
  /** Whether it should be running: a pause during a resume ends the node that resume starts */
  let wanted = true;
  let resuming: Promise<void> | null = null;
  /** Calls in flight, failed when the node under them ends */
  const inFlight = new Set<(error: Error) => void>();
  /** Bumped on each pause, so a call knows whether its node is still the one */
  let epoch = 0;

  const listeners = new Set<(event: NodeEvent) => void>();
  const watches = new Set<{ stop: () => void; attach: (node: P2PNode) => void }>();
  const holds = new Set<{
    release: (() => Promise<void>) | null;
    attach: (node: P2PNode) => Promise<void>;
  }>();
  let unsubscribe: (() => void) | null = null;
  let lastStatus = first.network.status();
  let lastDelegation = first.delegation();

  /** Hooks a new node up to everything that outlives it */
  async function attach(node: P2PNode): Promise<void> {
    unsubscribe = node.subscribe((event) => {
      for (const listener of listeners) listener(event);
    });
    for (const watch of watches) watch.attach(node);
    await Promise.all([...holds].map((hold) => hold.attach(node).catch(() => {})));
  }
  await attach(first);

  /** Runs `call` on the node, waiting for one; fails if that node ends before it answers */
  async function run<R>(call: (node: P2PNode) => R | Promise<R>): Promise<R> {
    if (closed) throw new Error('That node has closed');
    const node = await ready;
    const mine = epoch;
    return new Promise<R>((resolve, reject) => {
      if (mine !== epoch) return void reject(new Error(PUT_AWAY));
      const fail = (error: Error) => reject(error);
      inFlight.add(fail);
      Promise.resolve()
        .then(() => call(node))
        .then(resolve, reject)
        .finally(() => inFlight.delete(fail));
    });
  }

  const watch = <const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
    spaceId: string,
    query: Query<C, I>,
    onResult: (result: ResultFor<C, I>) => void,
    onError?: (error: Error) => void,
  ): (() => void) => {
    let stopInner: (() => void) | null = null;
    const entry = {
      stop: () => {
        stopInner?.();
        stopInner = null;
      },
      attach: (node: P2PNode) => {
        stopInner = node.records.watch(spaceId, query, onResult, onError);
      },
    };
    watches.add(entry);
    if (current) entry.attach(current.node);
    return () => {
      entry.stop();
      watches.delete(entry);
    };
  };

  const hold = async (spaceId: string): Promise<() => Promise<void>> => {
    const entry: { release: (() => Promise<void>) | null; attach: (node: P2PNode) => Promise<void> } = {
      release: null,
      attach: async (node) => {
        entry.release = await node.spaces.hold(spaceId);
      },
    };
    holds.add(entry);
    await run((node) => entry.attach(node)).catch((error: unknown) => {
      holds.delete(entry);
      throw error;
    });
    return async () => {
      if (!holds.delete(entry)) return;
      await entry.release?.().catch(() => {});
    };
  };

  // Everything else is asked of whichever node is under it.
  const here: { readonly [N in Namespace]?: Partial<P2PNode[N]> } = {
    spaces: { hold },
    records: { watch },
    network: {
      status: () => (current ? (lastStatus = current.node.network.status()) : lastStatus),
      reconnect: () => current?.node.network.reconnect(),
    },
  };

  const node: P2PNode = Object.freeze({
    did: first.did,
    sessionDid: first.sessionDid,
    ...buildNamespaces(
      (namespace, name) =>
        givenFor(here, namespace, name) ??
        ((...args: unknown[]) =>
          run((under): unknown => {
            const methods: unknown = Reflect.get(under, namespace);
            if (typeof methods !== 'object' || methods === null) throw new Error(`No ${namespace}`);
            return callMethod(methods, name, args);
          })),
    ),
    delegation: () => (current ? (lastDelegation = current.node.delegation()) : lastDelegation),
    iceServers: () => run((under) => under.iceServers()),
    setFileLimits: (limits) => run((under) => under.setFileLimits(limits)),
    revokeKey: (key, options) => run((under) => under.revokeKey(key, options)),
    revokeSelf: (options) => run((under) => under.revokeSelf(options)),
    asAgent: (agent) => run((under) => under.asAgent(agent)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const ending = current;
      current = null;
      unsubscribe?.();
      for (const fail of inFlight) fail(new Error('That node has closed'));
      await ending?.node.close();
    },
  } satisfies P2PNode);

  return {
    node,
    get running() {
      return current !== null;
    },
    pause() {
      wanted = false;
      if (!current || closed) return;
      const ending = current;
      current = null;
      epoch++;
      lastStatus = ending.node.network.status();
      unsubscribe?.();
      unsubscribe = null;
      for (const entry of watches) entry.stop();
      for (const entry of holds) entry.release = null;
      ready = new Promise((resolve) => (letThrough = resolve));
      for (const fail of inFlight) fail(new Error(PUT_AWAY));
      inFlight.clear();
      ending.end();
    },
    resume() {
      wanted = true;
      if (current || closed) return Promise.resolve();
      resuming ??= (async () => {
        try {
          const started = await start();
          // Put away again, or closed, while it started: not wanted now.
          if (closed || !wanted) return void started.end();
          current = started;
          await attach(started.node);
          letThrough?.(started.node);
          letThrough = null;
          ready = Promise.resolve(started.node);
        } finally {
          resuming = null;
        }
      })();
      return resuming;
    },
  };
}
