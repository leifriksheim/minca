/**
 * @module node/resumable
 * A node that can let go and come back, as one object: `pause` ends the node
 * under it, `resume` starts another, and whoever holds `node` keeps using
 * the same object throughout. A tab put away does this, so that a browser
 * that freezes background tabs (an iPhone's) never freezes one holding the
 * stores another tab's node is waiting on.
 *
 * Pausing lets the calls already running finish first, so none is cut off
 * half done, then ends the node; calls from then on wait for the next one.
 * Event listeners, watches and holds carry over to each new node. Closing
 * fails the calls still waiting.
 */
import { buildNamespaces, callMethod, givenFor, type Namespace } from './api.js';
import type { Query } from '../query/types.js';
import type { CollectionRef, IncludeMap, ResultFor } from '../query/types.js';
import type { NodeEvent, P2PNode } from './types.js';

export interface ResumableNode {
  /** The node to use: the same object, whichever node is under it */
  readonly node: P2PNode;
  /**
   * Lets go of the node under it: calls from now on wait, and once those
   * running are done (a few seconds at most), it ends (`end`). `now` ends it
   * at once, for a page being left, which may be frozen any moment.
   */
  pause(now?: boolean): void;
  /** Starts a node again, and lets waiting calls through */
  resume(): Promise<void>;
  /** Whether a node is under it, or still finishing what it was doing */
  readonly running: boolean;
}

interface Running {
  readonly node: P2PNode;
  /** Ends it now: a worker terminated, rather than asked to close */
  readonly end: () => void;
}

const CLOSED = 'That node has closed';
/** How long a pause waits for calls running to finish before ending the node anyway */
const DRAIN_MS = 3000;
/** Said of a call the node ended under: whether it was stored isn't known */
const UNSURE = 'This tab was put away before that finished: it may or may not have been saved';

/** A promise to settle later, from outside */
function gate<T>() {
  let open: (value: T) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Nobody may be waiting when it fails.
  promise.catch(() => {});
  return { promise, open, fail };
}

/**
 * Wraps the node `start` starts. `start` gives the node and how to end it at
 * once; it is called again on each `resume`.
 */
export async function resumableNode(start: () => Promise<Running>): Promise<ResumableNode> {
  let current: Running | null = await start();
  const first = current.node;
  /** Where calls wait while there's no node to take them; null while there is */
  let waiting: ReturnType<typeof gate<P2PNode>> | null = null;
  let closed = false;
  /** Whether it should be running: a pause during a resume ends the node that resume starts */
  let wanted = true;
  let resuming: Promise<void> | null = null;
  /** Letting go: waiting for the calls running to finish before ending the node */
  let draining = false;
  /** Calls running on the node under it, which a pause lets finish */
  const running = new Set<Promise<unknown>>();
  /** Fails the calls still running when the node under them ends */
  let cutOff = gate<never>();

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

  /** The node to call now, waiting while there is none */
  async function nodeNow(): Promise<P2PNode> {
    for (;;) {
      if (closed) throw new Error(CLOSED);
      if (waiting) await waiting.promise;
      else if (current) return current.node;
      else waiting = gate<P2PNode>();
    }
  }

  /** Runs `call` on the node, waiting for one; a pause lets it finish */
  async function run<R>(call: (node: P2PNode) => R | Promise<R>): Promise<R> {
    const node = await nodeNow();
    const done = Promise.resolve().then(() => call(node));
    running.add(done);
    void done.then(
      () => running.delete(done),
      () => running.delete(done),
    );
    // A node ended under it never answers: say so, rather than leave it waiting.
    return Promise.race([done, cutOff.promise]);
  }

  /** Ends the node under it, once what it was doing is done, unless it's wanted again by then */
  async function letGo(now: boolean): Promise<void> {
    draining = true;
    const deadline = Date.now() + (now ? 0 : DRAIN_MS);
    while (running.size > 0 && Date.now() < deadline)
      await Promise.race([
        Promise.allSettled([...running]),
        new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
      ]);
    draining = false;
    const ending = current;
    if (closed || !ending) return;
    if (wanted && !now) {
      // Back before it was let go: carry on with the same node.
      openTo(ending.node);
      return;
    }
    if (running.size > 0) {
      cutOff.fail(new Error(UNSURE));
      cutOff = gate<never>();
      running.clear();
    }
    current = null;
    lastStatus = ending.node.network.status();
    unsubscribe?.();
    unsubscribe = null;
    for (const entry of watches) entry.stop();
    for (const entry of holds) entry.release = null;
    ending.end();
  }

  /** Lets the calls that waited through, to `node` */
  function openTo(node: P2PNode): void {
    const opened = waiting;
    waiting = null;
    opened?.open(node);
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
    if (current && !draining) entry.attach(current.node);
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
      // Calls waiting for a node fail: there won't be one.
      waiting?.fail(new Error(CLOSED));
      waiting = null;
      await ending?.node.close();
    },
  } satisfies P2PNode);

  return {
    node,
    get running() {
      return current !== null;
    },
    pause(now = false) {
      wanted = false;
      if (!current || closed || (draining && !now)) return;
      // Calls from now on wait; those running finish on this node first.
      waiting ??= gate<P2PNode>();
      void letGo(now);
    },
    resume() {
      wanted = true;
      if (closed) return Promise.reject(new Error(CLOSED));
      // Still finishing what it was doing: it carries on (`letGo`).
      if (current) return Promise.resolve();
      resuming ??= (async () => {
        try {
          const started = await start();
          // Put away again, or closed, while it started: not wanted now.
          if (closed || !wanted) return void started.end();
          current = started;
          await attach(started.node);
          openTo(started.node);
        } finally {
          resuming = null;
        }
      })();
      return resuming;
    },
  };
}
