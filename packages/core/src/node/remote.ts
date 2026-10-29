/**
 * @module node/remote
 * A node running in one place, used from another. `serveNode` answers for a
 * node over a message port (a worker's, a frame's), and `remoteNode` is the
 * node at the other end, with the same API: a page keeps its main thread for
 * drawing while the node checks signatures, decrypts and syncs in a worker.
 *
 * What a node returns is plain data, so it crosses unchanged. Events and
 * `records.watch` become messages. `delegation()` and `network.status()`
 * answer at once, so this side keeps the last value the node reported.
 * Validators and typed collection references go as the JSON Schema and name
 * they stand for, because functions can't be cloned.
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

/** What `remoteNode` keeps of a node, to answer the calls that can't wait */
interface NodeState {
  readonly did: string;
  readonly sessionDid: string;
  readonly delegation: Delegation;
  readonly status: MeshStatus;
}

type Message = Record<string, unknown>;

/** Tags every message, so a port shared with other traffic can tell ours apart */
const TAG = 'minca-node';
const SIGNER_TAG = 'minca-signer';

/** The node's own methods that cross; every namespace's do (`node/api.ts`) */
const OWN_METHODS = Object.freeze({ iceServers: true, revokeKey: true, revokeSelf: true });

/** How often the served side checks for a renewed delegation between calls */
const DELEGATION_CHECK_MS = 60_000;

const CLOSED = 'That node has closed';

/**
 * Answers for `node` over `port`, until the returned function is called.
 * Stopping leaves the node running: closing it is its owner's to do, or the
 * other side's, through `close()`.
 */
export function serveNode(node: P2PNode, port: MessagePortLike): () => void {
  const post = (message: Message) => send(port, TAG, message);
  const watches = new Map<number, () => void>();
  const holds = new Map<number, () => Promise<void>>();
  let lastHold = 0;
  let sentSig = node.delegation().sig;
  let closed = false;

  function sendState(): void {
    const state = stateOf(node);
    sentSig = state.delegation.sig;
    post({ kind: 'state', state });
  }

  function checkDelegation(): void {
    if (node.delegation().sig !== sentSig) sendState();
  }

  const unsubscribe = node.subscribe((event) => {
    post({ kind: 'event', event });
    if (event.type === 'network') sendState();
  });
  const timer = setInterval(checkDelegation, DELEGATION_CHECK_MS);

  function stop(): void {
    clearInterval(timer);
    unsubscribe();
    for (const unwatch of watches.values()) unwatch();
    watches.clear();
    for (const release of holds.values()) void release().catch(() => {});
    holds.clear();
  }

  /** Calls that are not the node's own methods */
  const special = new Map<string, (args: ReadonlyArray<unknown>) => Promise<unknown>>([
    ['hello', async () => stateOf(node)],
    [
      'hold',
      async ([spaceId]) => {
        const id = ++lastHold;
        holds.set(id, await node.spaces.hold(String(spaceId)));
        return id;
      },
    ],
    [
      'release',
      async ([held]) => {
        const release = holds.get(Number(held));
        holds.delete(Number(held));
        await release?.();
      },
    ],
    [
      'close',
      async () => {
        // Later calls are told it has closed.
        closed = true;
        stop();
        await node.close();
      },
    ],
  ]);

  async function run(path: string, args: ReadonlyArray<unknown>): Promise<unknown> {
    if (closed) throw new Error(CLOSED);
    const method = special.get(path) ?? methodAt(node, path);
    if (!method) throw new Error(`A node has no method ${path}`);
    return await method(args);
  }

  function reply(id: number, value: unknown): void {
    try {
      post({ kind: 'reply', id, ok: true, value });
    } catch (error) {
      // A value that won't clone: say so, rather than leave the call waiting.
      post({ kind: 'reply', id, ok: false, error: sendable(error) });
    }
  }

  function onCall(message: Message): void {
    const { id, path } = message;
    if (typeof id !== 'number' || typeof path !== 'string') return;
    const args = Array.isArray(message.args) ? message.args : [];
    void run(path, args).then(
      (value) => {
        reply(id, value);
        checkDelegation();
      },
      (error: unknown) => post({ kind: 'reply', id, ok: false, error: sendable(error) }),
    );
  }

  function onWatch(message: Message): void {
    const { watch, space, query } = message;
    if (typeof watch !== 'number' || typeof space !== 'string') return;
    if (!isRecord(query)) {
      post({ kind: 'result', watch, error: sendable(new Error('Nothing to watch')) });
      return;
    }
    const unwatch = node.records.watch(
      space,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the query runner checks it and reports what's wrong through onError
      query as unknown as Query,
      (result) => post({ kind: 'result', watch, result }),
      (error) => post({ kind: 'result', watch, error: sendable(error) }),
    );
    watches.set(watch, unwatch);
  }

  function onUnwatch({ watch }: Message): void {
    if (typeof watch !== 'number') return;
    watches.get(watch)?.();
    watches.delete(watch);
  }

  const handlers: Record<string, (message: Message) => void> = {
    call: onCall,
    watch: onWatch,
    unwatch: onUnwatch,
  };
  const stopListening = listen(port, TAG, (message) => handlerFor(handlers, message)?.(message));
  return () => {
    stop();
    stopListening();
  };
}

/**
 * The node `serveNode` answers for on the other end of `port`: the same API,
 * each call a message. Resolves once the node has said who it is.
 */
export async function remoteNode(port: MessagePortLike): Promise<P2PNode> {
  const post = (message: Message) => send(port, TAG, message);
  const calls = createCalls();
  const listeners = new Set<(event: NodeEvent) => void>();
  const watchers = new Map<
    number,
    { readonly onResult: (result: unknown) => void; readonly onError: (error: Error) => void }
  >();
  let lastWatch = 0;
  let state: NodeState | null = null;
  /** Closed from this side: calls fail at once */
  let closed = false;

  const handlers: Record<string, (message: Message) => void> = {
    reply: calls.settle,
    event({ event }) {
      if (!isRecord(event)) return;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node sent it from its own subscribe
      const nodeEvent = event as NodeEvent;
      for (const listener of listeners) {
        try {
          listener(nodeEvent);
        } catch (error) {
          console.error(error);
        }
      }
    },
    state(message) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node sent it from its own state
      if (isRecord(message.state)) state = message.state as unknown as NodeState;
    },
    result(message) {
      const watcher = typeof message.watch === 'number' ? watchers.get(message.watch) : undefined;
      if (!watcher) return;
      if (message.error !== undefined) watcher.onError(received(message.error));
      else watcher.onResult(message.result);
    },
  };
  const stopListening = listen(port, TAG, (message) => handlerFor(handlers, message)?.(message));

  /** Calls a method of the node on the other end; it answers with that method's type */
  const ask = <R>(path: string, args: ReadonlyArray<unknown>): Promise<R> =>
    closed
      ? Promise.reject(new Error(CLOSED))
      : calls.call<R>((id) => post({ kind: 'call', id, path, args }));

  function watch<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
    spaceId: string,
    query: Query<C, I>,
    onResult: (result: ResultFor<C, I>) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const id = ++lastWatch;
    watchers.set(id, {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node ran this query
      onResult: (result) => onResult(result as ResultFor<C, I>),
      onError: onError ?? ((error) => console.error(error)),
    });
    try {
      post({ kind: 'watch', watch: id, space: spaceId, query: plainQuery(query) });
    } catch (error) {
      watchers.delete(id);
      throw error;
    }
    return () => {
      if (watchers.delete(id)) post({ kind: 'unwatch', watch: id });
    };
  }

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
      watch,
    },
    collections: {
      define: async (spaceId: string, definition: DefineCollection) =>
        ask<NodeCollection>('collections.define', [spaceId, storedDefinition(definition)]),
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
      stopListening();
      calls.rejectAll(new Error(CLOSED));
      watchers.clear();
    },
  } satisfies P2PNode);
}

/**
 * Signs session notes for a `remoteSigner` on the other side of `port`: only
 * the one note a node asks for, everything about the account
 * (`SESSION_COMMAND`) to its key until a time. The root key stays here: a
 * passkey needs a document, and a key in a tab should stay in that tab.
 * Returns a function that stops.
 */
export function serveSigner(signer: RootSigner, port: MessagePortLike): () => void {
  async function answer(message: Message): Promise<unknown> {
    if (message.kind === 'hello') return { did: signer.did };
    const { params } = message;
    if (message.kind !== 'delegate' || !isSessionRequest(params))
      throw new Error('A signer across a port signs only session notes');
    return signer.delegate({
      audience: params.audience,
      command: SESSION_COMMAND,
      expiration: params.expiration,
    });
  }

  return listen(port, SIGNER_TAG, (message) => {
    const { id } = message;
    if (typeof id !== 'number') return;
    void answer(message).then(
      (value) => send(port, SIGNER_TAG, { kind: 'reply', id, ok: true, value }),
      (error: unknown) => send(port, SIGNER_TAG, { kind: 'reply', id, ok: false, error: sendable(error) }),
    );
  });
}

/** The signer a `serveSigner` keeps on the other side of `port`, for `createNode` to sign sessions with */
export async function remoteSigner(port: MessagePortLike): Promise<RootSigner> {
  const calls = createCalls();
  listen(port, SIGNER_TAG, (message) => {
    if (message.kind === 'reply') calls.settle(message);
  });
  const ask = <R>(kind: string, params?: unknown): Promise<R> =>
    calls.call<R>((id) => send(port, SIGNER_TAG, { kind, params, id }));

  const { did } = await ask<Pick<RootSigner, 'did'>>('hello');
  return Object.freeze({
    did,
    delegate: async (params) => {
      const token = parseDelegation(await ask<unknown>('delegate', params));
      if (!token) throw new Error('The signer answered with something that is not a delegation');
      return token;
    },
  } satisfies RootSigner);
}

/** A session note's request, and nothing else: the far end still picks the key and the time */
function isSessionRequest(params: unknown): params is { audience: string; expiration: number } {
  return (
    isRecord(params) &&
    typeof params.audience === 'string' &&
    typeof params.expiration === 'number' &&
    params.command === SESSION_COMMAND &&
    params.subject === undefined &&
    params.policy === undefined
  );
}

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

/** The name a typed collection reference stands for; a validator can't be cloned */
const collectionName = (ref: unknown): unknown =>
  isRecord(ref) && typeof ref.name === 'string' ? ref.name : ref;

const stateOf = (node: P2PNode): NodeState => ({
  did: node.did,
  sessionDid: node.sessionDid,
  delegation: node.delegation(),
  status: node.network.status(),
});

/** The method a call names, bound to its namespace, or null when it is not one that crosses */
function methodAt(node: P2PNode, path: string): ((args: ReadonlyArray<unknown>) => unknown) | null {
  const parts = path.split('.');
  const [first, second] = parts;
  if (first === undefined || parts.length > 2) return null;
  const listed: unknown =
    second === undefined ? OWN_METHODS : Object.hasOwn(API, first) ? Reflect.get(API, first) : null;
  const name = second ?? first;
  const owner: unknown = second === undefined ? node : Reflect.get(node, first);
  if (!isRecord(listed) || !Object.hasOwn(listed, name) || !isRecord(owner)) return null;
  return (args) => callMethod(owner, name, args);
}

function handlerFor(
  handlers: Record<string, (message: Message) => void>,
  message: Message,
): ((message: Message) => void) | undefined {
  const { kind } = message;
  return typeof kind === 'string' && Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
}

// Messages: tagged, so a port shared with other traffic can tell ours apart.

function send(port: MessagePortLike, tag: string, message: Message): void {
  port.postMessage({ [tag]: true, ...message });
}

/** Hears the messages tagged `tag` on `port`; returns a function that stops */
function listen(port: MessagePortLike, tag: string, handle: (message: Message) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (isRecord(message) && message[tag] === true) handle(message);
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return () => port.removeEventListener('message', onMessage);
}

/** Calls sent across a port, waiting for their replies by id */
function createCalls() {
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let lastId = 0;
  return {
    /** Sends a call with `post`; resolves with its reply's value */
    call: <R>(post: (id: number) => void): Promise<R> =>
      new Promise<R>((resolve, reject) => {
        const id = ++lastId;
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the other side ran the call this one stands for
        waiting.set(id, { resolve: (value) => resolve(value as R), reject });
        try {
          post(id);
        } catch (error) {
          // An argument that won't clone, a function say.
          waiting.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    settle: (message: Message): void => {
      const id = Number(message.id);
      const call = waiting.get(id);
      waiting.delete(id);
      if (message.ok === true) call?.resolve(message.value);
      else call?.reject(received(message.error));
    },
    rejectAll: (error: Error): void => {
      for (const call of waiting.values()) call.reject(error);
      waiting.clear();
    },
  };
}

// Errors cross as plain fields.

function sendable(error: unknown): { name: string; message: string; code?: unknown } {
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
