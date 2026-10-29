/**
 * @module node-records
 * The records namespace: reading, writing and querying a space's records,
 * as the node's own session or as an agent's key.
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
import { serial } from '../utils/serial.js';
import type { ActiveSession, SpaceRuntime } from './space-runtime.js';
import type { FileRef, ListOptions, NodeEvent, NodeRecords } from './types.js';

interface RecordsNeeds {
  readonly runtime: (spaceId: string) => Promise<SpaceRuntime>;
  readonly subscribe: (listener: (event: NodeEvent) => void) => () => void;
}

/** The records namespace, writing as `as` when given: an agent's key and note */
export function createNodeRecords(needs: RecordsNeeds, as?: ActiveSession): NodeRecords {
  const { runtime } = needs;
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
      const unsubscribe = needs.subscribe((event) => {
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
