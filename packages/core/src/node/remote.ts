/**
 * @module node/remote
 * A node running in one place, used from another. `serveNode` answers for a
 * node over a message port (a worker's, a frame's), and `remoteNode` is the
 * node at the other end of that port, with the same API. A page can then keep
 * its main thread for drawing and input while the node checks signatures,
 * decrypts and syncs in a worker.
 *
 * What a node returns is plain data already (see `node/types`), so it crosses
 * unchanged. The exceptions: events and `records.watch` become messages.
 * `delegation()` and `network.status()` answer at once, so this side keeps
 * the last value the node reported. Validators and typed collection references go as the JSON
 * Schema and name they stand for, because functions can't be cloned.
 */
import type { MeshStatus } from '../network/mesh.js';
import { parseDelegation, type Delegation } from '../identity/ucan.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Query } from '../query/types.js';
import { plainQuery, type CollectionRef, type IncludeMap, type ResultFor } from '../query/types.js';
import { toJsonSchema } from '../schema/collection-def.js';
import { storedComputed, storedContract } from '../records/contract-builder.js';
import { isRecord } from '../utils/guards.js';
import { SESSION_COMMAND } from './node.js';
import type { MessagePortLike } from '../utils/port.js';
import type { DefineCollection, NodeCollection, NodeEvent, P2PNode } from './types.js';
import { API, buildNamespaces, callMethod, givenFor, type Namespace } from './api.js';

/** A definition as plain data: its schema as JSON Schema, a contract or computed fields built in TypeScript as their CEL */
function storedDefinition(definition: DefineCollection): DefineCollection {
  const { contract: _built, computed: _derived, ...rest } = definition;
  const contract = storedContract(definition);
  const computed = storedComputed(definition);
  return {
    ...rest,
    schema: toJsonSchema(definition.schema),
    ...(contract !== undefined ? { contract } : {}),
    ...(computed !== undefined ? { computed } : {}),
  };
}

/** What `remoteNode` keeps of a node, to answer the calls that can't wait */
interface NodeState {
  readonly did: string;
  readonly sessionDid: string;
  readonly delegation: Delegation;
  readonly status: MeshStatus;
}

/** Tags every message, so a port shared with other traffic can tell ours apart */
const TAG = 'minca-node';

/** The node's own methods that cross; every namespace's do (`node/api.ts`) */
const OWN_METHODS = Object.freeze({ iceServers: true, revokeKey: true, revokeSelf: true });

/** How often the served side checks for a renewed delegation between calls */
const DELEGATION_CHECK_MS = 60_000;

interface SentError {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
}

function sendable(error: unknown): SentError {
  if (!isRecord(error)) return { name: 'Error', message: String(error) };
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : 'The node failed',
    ...(error.code !== undefined ? { code: error.code } : {}),
  };
}

function received(sent: unknown): Error {
  const fields = isRecord(sent) ? sent : {};
  const error = new Error(typeof fields.message === 'string' ? fields.message : 'The node failed');
  if (typeof fields.name === 'string') error.name = fields.name;
  if (fields.code !== undefined) Object.assign(error, { code: fields.code });
  return error;
}

const stateOf = (node: P2PNode): NodeState => ({
  did: node.did,
  sessionDid: node.sessionDid,
  delegation: node.delegation(),
  status: node.network.status(),
});

/** The method a call names, bound to its namespace, or null when it is not one that crosses */
function methodAt(node: P2PNode, path: string): ((...args: unknown[]) => unknown) | null {
  const parts = path.split('.');
  const [first, second] = parts;
  if (first === undefined || parts.length > 2) return null;
  const listed: unknown =
    second === undefined ? OWN_METHODS : Object.hasOwn(API, first) ? Reflect.get(API, first) : null;
  const name = second ?? first;
  const owner: unknown = second === undefined ? node : Reflect.get(node, first);
  if (!isRecord(listed) || !Object.hasOwn(listed, name) || !isRecord(owner)) return null;
  return (...args: unknown[]): unknown => callMethod(owner, name, args);
}

/**
 * Answers for `node` over `port`, until the returned function is called.
 * Stopping leaves the node running: closing it is its owner's to do, or the
 * other side's, through `close()`.
 */
export function serveNode(node: P2PNode, port: MessagePortLike): () => void {
  const watches = new Map<number, () => void>();
  const holds = new Map<number, () => Promise<void>>();
  let nextHold = 0;
  let sent = node.delegation().sig;
  let closed = false;

  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [TAG]: true, ...message });
  };
  const sendState = () => {
    const state = stateOf(node);
    sent = state.delegation.sig;
    post({ kind: 'state', state });
  };
  /** Sends the delegation again when the node has renewed it */
  const checkDelegation = () => {
    if (node.delegation().sig !== sent) sendState();
  };
  const unsubscribe = node.subscribe((event) => {
    post({ kind: 'event', event });
    if (event.type === 'network') sendState();
  });
  const timer = setInterval(checkDelegation, DELEGATION_CHECK_MS);
  const stop = () => {
    clearInterval(timer);
    unsubscribe();
    for (const unwatch of watches.values()) unwatch();
    watches.clear();
    for (const release of holds.values()) void release().catch(() => {});
    holds.clear();
  };

  const run = async (path: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
    if (closed) throw new Error('That node has closed');
    if (path === 'hello') return stateOf(node);
    if (path === 'hold') {
      const release = await node.spaces.hold(String(args[0]));
      const id = ++nextHold;
      holds.set(id, release);
      return id;
    }
    if (path === 'release') {
      const release = holds.get(Number(args[0]));
      holds.delete(Number(args[0]));
      await release?.();
      return undefined;
    }
    if (path === 'close') {
      // With the node closed there is nothing left to renew; later calls are told it has closed.
      closed = true;
      stop();
      await node.close();
      return undefined;
    }
    const method = methodAt(node, path);
    if (!method) throw new Error(`A node has no method ${path}`);
    return await method(...args);
  };

  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true) return;
    if (message.kind === 'call' && typeof message.id === 'number' && typeof message.path === 'string') {
      const { id } = message;
      const args = Array.isArray(message.args) ? message.args : [];
      void run(message.path, args).then(
        (value) => {
          try {
            post({ kind: 'reply', id, ok: true, value });
          } catch (error) {
            // A value that won't clone: say so, rather than leave the call waiting.
            post({ kind: 'reply', id, ok: false, error: sendable(error) });
          }
          checkDelegation();
        },
        (error: unknown) => post({ kind: 'reply', id, ok: false, error: sendable(error) }),
      );
    } else if (
      message.kind === 'watch' &&
      typeof message.watch === 'number' &&
      typeof message.space === 'string'
    ) {
      const { watch } = message;
      if (!isRecord(message.query)) {
        post({ kind: 'result', watch, error: sendable(new Error('Nothing to watch')) });
        return;
      }
      const unwatch = node.records.watch(
        message.space,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the query runner checks it and reports what's wrong through onError
        message.query as unknown as Query,
        (result) => post({ kind: 'result', watch, result }),
        (error) => post({ kind: 'result', watch, error: sendable(error) }),
      );
      watches.set(watch, unwatch);
    } else if (message.kind === 'unwatch' && typeof message.watch === 'number') {
      watches.get(message.watch)?.();
      watches.delete(message.watch);
    }
  };

  port.addEventListener('message', onMessage);
  port.start?.();
  return () => {
    stop();
    port.removeEventListener('message', onMessage);
  };
}

/**
 * The node `serveNode` answers for on the other end of `port`: the same API,
 * each call a message. Resolves once the node has said who it is.
 */
export async function remoteNode(port: MessagePortLike): Promise<P2PNode> {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: NodeEvent) => void>();
  let state: NodeState | null = null;
  const watchers = new Map<
    number,
    { readonly onResult: (result: unknown) => void; readonly onError: (error: Error) => void }
  >();
  /** Closed from this side: calls fail at once */
  let closed = false;
  let nextId = 0;

  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [TAG]: true, ...message });
  };

  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true) return;
    if (message.kind === 'reply' && typeof message.id === 'number') {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok === true) waiting?.resolve(message.value);
      else waiting?.reject(received(message.error));
    } else if (message.kind === 'event' && isRecord(message.event)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node sent it from its own subscribe
      const nodeEvent = message.event as NodeEvent;
      for (const listener of listeners) {
        try {
          listener(nodeEvent);
        } catch (error) {
          console.error(error);
        }
      }
    } else if (message.kind === 'state' && isRecord(message.state)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node sent it from its own state
      state = message.state as unknown as NodeState;
    } else if (message.kind === 'result' && typeof message.watch === 'number') {
      const watcher = watchers.get(message.watch);
      if (!watcher) return;
      if (message.error !== undefined) watcher.onError(received(message.error));
      else watcher.onResult(message.result);
    }
  };
  port.addEventListener('message', onMessage);
  port.start?.();

  /** Calls a method of the node on the other end; it answers with that method's type */
  const ask = <R>(path: string, args: ReadonlyArray<unknown>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (closed) {
        reject(new Error('That node has closed'));
        return;
      }
      const id = ++nextId;
      pending.set(id, {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node ran the method this one stands for
        resolve: (value) => resolve(value as R),
        reject,
      });
      try {
        post({ kind: 'call', id, path, args });
      } catch (error) {
        // An argument that won't clone, a function say.
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  /** The name a typed collection reference stands for; a validator can't be cloned */
  const collectionName = (ref: unknown): unknown =>
    isRecord(ref) && typeof ref.name === 'string' ? ref.name : ref;

  const initial = await ask<NodeState>('hello', []);
  const current = () => state ?? initial;
  // Every method is asked of the other end, except these.
  const here: { readonly [N in Namespace]?: Partial<P2PNode[N]> } = {
    spaces: {
      async hold(spaceId: string) {
        const held = await ask<number>('hold', [spaceId]);
        return () => ask<void>('release', [held]);
      },
      authenticator: () =>
        Promise.reject(new Error('A node in a worker serves no sockets; ask the node that holds the space')),
    },
    records: {
      // Either overload: the record comes back typed as the call asked.
      put: (...args: unknown[]) =>
        ask<never>('records.put', [args[0], collectionName(args[1]), ...args.slice(2)]),
      query: <const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
        spaceId: string,
        query: Query<C, I>,
      ) => ask<ResultFor<C, I>>('records.query', [spaceId, plainQuery(query)]),
      watch: <const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
        spaceId: string,
        query: Query<C, I>,
        onResult: (result: ResultFor<C, I>) => void,
        onError?: (error: Error) => void,
      ) => {
        const watch = ++nextId;
        watchers.set(watch, {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node ran this query
          onResult: (result) => onResult(result as ResultFor<C, I>),
          onError: onError ?? ((error) => console.error(error)),
        });
        try {
          post({ kind: 'watch', watch, space: spaceId, query: plainQuery(query) });
        } catch (error) {
          watchers.delete(watch);
          throw error;
        }
        return () => {
          if (!watchers.delete(watch)) return;
          post({ kind: 'unwatch', watch });
        };
      },
    },
    collections: {
      define: async (spaceId: string, definition: DefineCollection) =>
        ask<NodeCollection>('collections.define', [
          spaceId,
          // Plain data: a contract or computed fields built in TypeScript are functions, which can't be posted.
          storedDefinition(definition),
        ]),
    },
    network: {
      status: () => current().status,
      reconnect: () => {
        void ask('network.reconnect', []).catch(() => {});
      },
    },
  };
  return Object.freeze({
    did: initial.did,
    sessionDid: initial.sessionDid,
    ...buildNamespaces(
      (namespace, name) =>
        givenFor(here, namespace, name) ?? ((...args: unknown[]) => ask(`${namespace}.${name}`, args)),
    ),
    delegation: () => current().delegation,
    iceServers: () => ask<ReadonlyArray<RTCIceServer>>('iceServers', []),
    revokeKey: (key, options) => ask('revokeKey', options ? [key, options] : [key]),
    revokeSelf: (options) => ask('revokeSelf', options ? [options] : []),
    // Its keys would have to cross the port; an agent is started on the node itself.
    asAgent: () => Promise.reject(new Error('An agent is started on the node itself, not across a port.')),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      await ask('close', []);
      closed = true;
      listeners.clear();
      port.removeEventListener('message', onMessage);
      for (const waiting of pending.values()) waiting.reject(new Error('That node has closed'));
      pending.clear();
      watchers.clear();
    },
  } satisfies P2PNode);
}

const SIGNER_TAG = 'minca-signer';

/**
 * Signs session notes for a `remoteSigner` on the other side of `port`: the
 * one note a node asks for, everything about the account (`SESSION_COMMAND`)
 * to its key until a time. No other shape: the far end still picks the key and
 * the time, as the node it runs does. The root key stays here: a
 * passkey needs a document, and a key in a tab should stay in the tab that
 * holds it. Returns a function that stops.
 */
export function serveSigner(signer: RootSigner, port: MessagePortLike): () => void {
  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [SIGNER_TAG]: true, ...message });
  };
  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[SIGNER_TAG] !== true || typeof message.id !== 'number') return;
    const { id } = message;
    const run = async (): Promise<unknown> => {
      if (message.kind === 'hello') return { did: signer.did };
      const params = message.params;
      if (
        message.kind !== 'delegate' ||
        !isRecord(params) ||
        typeof params.audience !== 'string' ||
        typeof params.expiration !== 'number' ||
        params.command !== SESSION_COMMAND ||
        params.subject !== undefined ||
        params.policy !== undefined
      )
        throw new Error('A signer across a port signs only session notes');
      return signer.delegate({
        audience: params.audience,
        command: SESSION_COMMAND,
        expiration: params.expiration,
      });
    };
    void run().then(
      (value) => post({ kind: 'reply', id, ok: true, value }),
      (error: unknown) => post({ kind: 'reply', id, ok: false, error: sendable(error) }),
    );
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return () => port.removeEventListener('message', onMessage);
}

/** The signer a `serveSigner` keeps on the other side of `port`, for `createNode` to sign sessions with */
export async function remoteSigner(port: MessagePortLike): Promise<RootSigner> {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  port.addEventListener('message', (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[SIGNER_TAG] !== true || message.kind !== 'reply') return;
    const waiting = pending.get(Number(message.id));
    pending.delete(Number(message.id));
    if (message.ok === true) waiting?.resolve(message.value);
    else waiting?.reject(received(message.error));
  });
  port.start?.();
  const ask = <R>(message: Record<string, unknown>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the signer on the other side answered this call
        resolve: (value) => resolve(value as R),
        reject,
      });
      port.postMessage({ [SIGNER_TAG]: true, kind: message.kind, params: message.params, id });
    });
  const { did } = await ask<Pick<RootSigner, 'did'>>({ kind: 'hello' });
  return Object.freeze({
    did,
    delegate: async (params) => {
      const token = parseDelegation(await ask<unknown>({ kind: 'delegate', params }));
      if (!token) throw new Error('The signer answered with something that is not a delegation');
      return token;
    },
  } satisfies RootSigner);
}
