/**
 * @module node-records
 * Reading, writing and querying a space's records: as the node's session, as
 * an agent's key, or sealed as direct messages.
 */
import { runQuery } from '../query/engine.js';
import {
  nameOf,
  plainQuery,
  type CollectionRef,
  type Include,
  type IncludeMap,
  type Query,
  type ResultFor,
} from '../query/types.js';
import type { Link } from '../types.js';
import { didOf } from '../identity/did.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import { grantsRecordsOnly, noteSpaces } from '../identity/abilities.js';
import { direct as directSchema } from '../schemas/library/publishing.js';
import { openDirect, sealDirect, type DirectBody } from '../privacy/direct.js';
import { isRecord } from '../utils/guards.js';
import { serial } from '../utils/serial.js';
import type { SpaceRuntime } from './space-runtime.js';
import { CANNOT_DEFINE } from './space-writing.js';
import type { ActiveSession } from './space-versions.js';
import { buildNamespaces, callMethod, givenFor, type Namespace, type OwnMethods } from './api.js';
import type {
  DirectMessage,
  FileRef,
  ListOptions,
  NodeDirect,
  NodeEvent,
  NodeRecord,
  NodeRecords,
  P2PNode,
} from './types.js';
import { ensureDefined, type NodeContext } from './node-context.js';

/** The records namespace, writing as `as` when given: an agent's key and note */
export function createNodeRecords(ctx: NodeContext, as?: ActiveSession): NodeRecords {
  const { runtime } = ctx;
  const self: NodeRecords = Object.freeze({
    list: async <T>(spaceId: string, options?: ListOptions) => (await runtime(spaceId)).list<T>(options),
    get: async <T>(spaceId: string, key: string) => (await runtime(spaceId)).get<T>(key),
    contracts: async (spaceId: string, key: string, version?: string) =>
      (await runtime(spaceId)).contracts(key, version),
    keyFor: async (spaceId: string, name: string, account?: string) =>
      (await runtime(spaceId)).keyFor(name, account),
    onePerKey: async (
      spaceId: string,
      collection: string,
      body: unknown,
      options?: { links?: ReadonlyArray<Link>; account?: string },
    ) => (await runtime(spaceId)).onePerKey(collection, body, options),
    put: async <T>(
      spaceId: string,
      collection: CollectionRef,
      body: T,
      options?: { key?: string; links?: ReadonlyArray<Link> },
    ) => (await runtime(spaceId)).put<T>(nameOf(collection), body, as ? { ...options, as } : options),
    update: async <T>(spaceId: string, key: string, body: T, options?: { links?: ReadonlyArray<Link> }) =>
      (await runtime(spaceId)).update<T>(key, body, as ? { ...options, as } : options),
    linked: async <T>(spaceId: string, key: string, options?: { rel?: string; collection?: string }) =>
      (await runtime(spaceId)).linked<T>(key, options),
    delete: async (spaceId: string, key: string) =>
      (await runtime(spaceId)).remove(key, as ? { as } : undefined),
    history: async <T>(spaceId: string, key: string) => (await runtime(spaceId)).history<T>(key),
    addFile: async (spaceId: string, bytes: Uint8Array, about: { mime: string; name?: string }) => ({
      ...(await (await runtime(spaceId)).addFile(bytes)),
      mime: about.mime,
      ...(about.name !== undefined ? { name: about.name } : {}),
    }),
    readFile: async (spaceId: string, ref: FileRef) => (await runtime(spaceId)).readFile(ref),
    can: async (spaceId: string, action: 'create' | 'edit' | 'delete', target: string) =>
      (await runtime(spaceId)).can(action, target),
    async query<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
      spaceId: string,
      query: Query<C, I>,
    ): Promise<ResultFor<C, I>> {
      const space = await runtime(spaceId);
      // Asked before running, so a node holding part of the space starts fetching what it lacks.
      const complete = space.use(collectionsOf(plainQuery(query)));
      const result = await runQuery(
        {
          list: (collection) => space.list({ collection }),
          get: (key) => space.get(key),
          linked: (key, options) => space.linked(key, options),
          computed: (collection) => space.computed(collection),
        },
        query,
      );
      // The query's type says what it finds; running it can't prove that.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed from the query
      return { ...result, complete } as ResultFor<C, I>;
    },
    watch<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
      spaceId: string,
      query: Query<C, I>,
      onResult: (result: ResultFor<C, I>) => void,
      onError?: (error: Error) => void,
    ) {
      let stopped = false;
      // Changes arrive in bursts during sync: one run at a time, never a queue of stale runs.
      const run = serial(async () => {
        if (stopped) return;
        try {
          const result = await self.query(spaceId, query);
          if (!stopped) onResult(result);
        } catch (error) {
          if (!stopped) onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const unsubscribe = ctx.subscribe((event) => {
        if (event.type === 'records' && event.space === spaceId) void run();
      });
      void run();
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
  });
  return self;
}

/** Every collection a query reads: its own, and each `include … from` */
function collectionsOf(query: Query): string[] {
  const plain = plainQuery(query);
  const found = new Set<string>();
  if (typeof plain.collection === 'string') found.add(plain.collection);
  const walk = (includes: Readonly<Record<string, Include>> | undefined) => {
    for (const include of Object.values(includes ?? {})) {
      if (typeof include?.from === 'string') found.add(include.from);
      walk(include?.include);
    }
  };
  walk(plain.include);
  return [...found];
}

/** Direct messages in a space, sealed to the member keys of those they are for (`packages/core/docs/direct-messages.md`) */
export function createNodeDirect(ctx: NodeContext): NodeDirect {
  const me = ctx.config.signer.did;

  /** A direct message as this account reads it — null when it is neither by nor for this account */
  async function directView(
    spaceId: string,
    open: SpaceRuntime,
    record: NodeRecord<DirectBody>,
  ): Promise<DirectMessage | null> {
    // Who wrote it is whoever created it: the context binds that account, so a copy posted by anyone else opens nothing.
    const from = record.createdBy;
    if (!record.verified || record.collection !== directSchema.name || !from || record.root !== from)
      return null;
    const to = Array.isArray(record.body?.to) ? record.body.to.filter((did) => typeof did === 'string') : [];
    if (from !== me && !to.includes(me)) return null;
    const pair = open.ownMemberKey();
    const opened = pair ? await openDirect(spaceId, from, record.body, me, pair) : null;
    return Object.freeze({
      key: record.key,
      from,
      to: [...to].sort(),
      text: opened?.text ?? null,
      createdAt: record.createdAt,
      ...(record.recordsOnly ? { recordsOnly: true as const } : {}),
    });
  }

  return Object.freeze<NodeDirect>({
    async reachable(spaceId) {
      const open = await ctx.runtime(spaceId);
      const { members } = await open.access();
      const keys = await open.memberKeys();
      return members
        .map((member) => member.did)
        .filter((did) => did !== me && keys.has(did))
        .sort();
    },

    async send(spaceId, to, text) {
      const open = await ctx.runtime(spaceId);
      const pair = open.ownMemberKey();
      if (!pair)
        throw new Error(
          "This node can't seal direct messages here: it wasn't given your member key for this space.",
        );
      const trimmed = text.trim();
      if (!trimmed) throw new Error('A direct message needs some text');
      // Your own key as this node holds it, so your other devices read what you sent even before it is published.
      const keys = new Map(await open.memberKeys());
      keys.set(me, pair.publicKey);
      const body = await sealDirect(spaceId, me, to, { text: trimmed }, keys);
      await ensureDefined(open, directSchema);
      const record = await open.put<DirectBody>(directSchema.name, body);
      const view = await directView(spaceId, open, record);
      if (!view) throw new Error('The direct message was written, but could not be read back');
      return view;
    },

    async list(spaceId) {
      const open = await ctx.runtime(spaceId);
      const found: DirectMessage[] = [];
      for (const record of await open.list<DirectBody>({ collection: directSchema.name })) {
        const view = await directView(spaceId, open, record);
        if (view) found.push(view);
      }
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    },
  });
}

/**
 * An agent acting through a node: its own key, under a records-only note
 * the account gave it, reaching only the spaces that note names. What each
 * method may do is the table in `packages/core/src/node/api.ts`.
 */
export async function startAgent(
  node: P2PNode,
  agent: { readonly keys: CryptoKeyPair; readonly note: Delegation },
  ctx: NodeContext,
): Promise<P2PNode> {
  const { spaces, records, hosting, contacts, direct } = node;
  const { contactsSpaceId } = ctx;
  const agentDid = await didOf(agent.keys.publicKey, ctx.provider);
  const checked = await verifyNote(agent.note, ctx.provider);
  if (!checked.valid) throw new Error(`The agent's note does not check out: ${checked.reason}`);
  const { note } = checked;
  if (!grantsRecordsOnly(note))
    throw new Error(
      'That note grants more than records — ask the account home for one with `recordsOnly: true`.',
    );
  if (note.payload.aud !== agentDid) throw new Error('That note was made out to a different key.');
  if (note.payload.iss !== node.did) throw new Error('That note is from a different account.');

  // The spaces its note names; all of them for an agent granted the whole account.
  // What it may do there is its note's to say; this node also refuses, by the label, what needs a person.
  const reach = noteSpaces(note);
  const named = new Set(reach === 'all' ? [] : reach);
  const allowed = (spaceId: unknown) =>
    reach === 'all' || (typeof spaceId === 'string' && named.has(spaceId));
  const contactsGiven = () => contactsSpaceId !== null && allowed(contactsSpaceId);
  // Written with the agent's key, under its note.
  const writes = createNodeRecords(ctx, { did: agentDid, key: agent.keys.privateKey, proof: () => note });

  // What the table in `node/api.ts` marks `own`; the rest it decides there.
  const own: { readonly [N in Namespace as keyof OwnMethods<N> extends never ? never : N]: OwnMethods<N> } = {
    spaces: {
      list: async () => (await spaces.list()).filter((space) => allowed(space.id)),
      get: async (spaceId) => (allowed(spaceId) ? spaces.get(spaceId) : null),
      authenticator: async () => null,
    },
    records: {
      can: async (spaceId, action, target) => allowed(spaceId) && records.can(spaceId, action, target),
      watch: (spaceId, query, onResult, onError) => {
        if (allowed(spaceId)) return records.watch(spaceId, query, onResult, onError);
        onError?.(new Error('The agent was not given this space.'));
        return () => {};
      },
    },
    // The runtime refuses this too, and every peer ignores it — said early, with what to do instead.
    collections: {
      define: async () => {
        throw new Error(CANNOT_DEFINE);
      },
    },
    hosting: {
      space: async (spaceId) => {
        if (!allowed(spaceId)) throw new Error('That space was not given to this agent');
        return hosting.space(spaceId);
      },
      over: async (spaceId) => (allowed(spaceId) ? hosting.over(spaceId) : []),
    },
    contacts: {
      space: async () => (contactsGiven() ? contactsSpaceId : null),
      list: async () => (contactsGiven() ? contacts.list() : []),
      get: async (did) => (contactsGiven() ? contacts.get(did) : null),
    },
    direct: { reachable: async (spaceId) => (allowed(spaceId) ? direct.reachable(spaceId) : []) },
    inbox: { get: async () => null },
  };
  const person = (what: string) => async (): Promise<never> => {
    throw new Error(`An agent can't ${what}. Ask the person to do it.`);
  };

  return Object.freeze({
    did: node.did,
    sessionDid: agentDid,
    ...buildNamespaces((namespace, name, policy) => {
      if (policy === 'own') return givenFor(own, namespace, name);
      const source: unknown = namespace === 'records' ? writes : Reflect.get(node, namespace);
      if (!isRecord(source)) throw new Error(`A node has no ${namespace}`);
      if (policy === 'pass') return (...args: unknown[]) => callMethod(source, name, args);
      if (policy !== 'scoped') return person(policy);
      return async (...args: unknown[]) => {
        if (!allowed(args[0]))
          throw new Error(
            'The agent was not given this space. The person can give it more in their account home.',
          );
        return callMethod(source, name, args);
      };
    }),
    delegation: () => note,
    iceServers: () => node.iceServers(),
    asAgent: person('start another agent'),
    revokeKey: person('revoke a key'),
    revokeSelf: person('sign the account out'),
    subscribe: (listener: (event: NodeEvent) => void) =>
      node.subscribe((event) => {
        if (!('space' in event) || allowed(event.space)) listener(event);
      }),
    // The agent stops; the node it acts through keeps running.
    close: async () => {},
  }) satisfies P2PNode;
}
