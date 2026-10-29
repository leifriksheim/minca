/**
 * @module node/space-index
 * What counts now: every record's counted version, read from the store once
 * and then kept up to date a key at a time. Placing a version marks its key
 * stale, and only that key is read again; a change that could alter other
 * verdicts — the space's own records, new keys, a store someone else wrote —
 * throws the whole index away. And what points where, derived from the same
 * records and never synced: any node holding them can build it.
 */
import type { Version } from '../types.js';
import { DEFINE_COMMAND, grantsBeyondRecords } from '../identity/abilities.js';
import { isStub } from '../schema/version.js';
import type { ListOptions, NodeRecord } from './types.js';
import { type Versions, NO_CHECKS, type SpaceBase } from './space-versions.js';
import type { StandingJudge } from './space-standing.js';
import type { Checks } from './space-checks.js';
import type { Catalog } from './space-catalog.js';

/** Freezes a value and everything inside it, in place */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

export function createIndex({
  space,
  storage,
  versions,
  standing,
  checks,
  catalog,
  use,
}: SpaceBase & {
  readonly versions: Versions;
  readonly standing: StandingJudge;
  readonly checks: Checks;
  readonly catalog: Catalog;
  /** Told the collections a reader asks for (`node/space-holding.ts`) */
  readonly use: (collections: ReadonlyArray<string>) => void;
}) {
  const { judge, openBody, genesisOf, consistent, createdAtOf } = versions;
  const { standingOf } = standing;
  const { checksOf, counts } = checks;
  const { contentIssues } = catalog;

  /**
   * The version of a record that counts: the current one, unless it no longer
   * stands — then the newest one before it that does, if the store kept one.
   */
  async function currentOf(recordKey: string): Promise<Version | null> {
    const current = await storage.getCurrent(recordKey);
    if (!current || !(await consistent(current))) return null;
    // A stub on top: the body of the version after it is on its way.
    if (!isStub(current) && (await counts(current))) return current;
    for (const version of await storage.history(recordKey)) {
      if (version.id === current.id || isStub(version) || !(await consistent(version))) continue;
      if (await counts(version)) return version;
    }
    return null;
  }

  interface Counted {
    readonly version: Version;
    readonly createdAt: string;
    /** Worked out the first time it is read */
    shown?: Promise<NodeRecord<unknown>>;
  }
  let countedIndex: Promise<Map<string, Counted>> | null = null;
  const staleKeys = new Set<string>();
  /** One read of the index at a time, so a key is never brought up to date twice at once */
  let indexing: Promise<unknown> = Promise.resolve();

  const countedEntry = async (version: Version): Promise<Counted> => ({
    version,
    createdAt: await createdAtOf(version),
  });

  async function buildIndex(): Promise<Map<string, Counted>> {
    staleKeys.clear();
    const index = new Map<string, Counted>();
    for (const version of await storage.listCurrent()) {
      const counted =
        !isStub(version) && (await counts(version)) && (await consistent(version))
          ? version
          : await currentOf(version.key);
      if (counted) index.set(counted.key, await countedEntry(counted));
    }
    return index;
  }

  function counted(): Promise<Map<string, Counted>> {
    const run = indexing.then(async () => {
      const index = await (countedIndex ??= buildIndex().catch((error) => {
        countedIndex = null;
        throw error;
      }));
      for (const key of [...staleKeys]) {
        staleKeys.delete(key);
        const version = await currentOf(key);
        if (version) index.set(key, await countedEntry(version));
        else index.delete(key);
      }
      return index;
    });
    indexing = run.catch(() => {});
    return run;
  }

  /** Every record that counts, current version each — deletes included */
  async function everyCurrent(collection?: string): Promise<Version[]> {
    const shown: Version[] = [];
    for (const entry of (await counted()).values())
      if (!collection || entry.version.collection === collection) shown.push(entry.version);
    return shown;
  }

  async function view<T>(version: Version): Promise<NodeRecord<T>> {
    const [{ body, links, encrypted }, verdict, genesis, stands] = await Promise.all([
      openBody(version),
      judge(version),
      genesisOf(version),
      standingOf(version),
    ]);
    const creator = genesis ? await judge(genesis) : null;
    // One record is handed to every reader, so nobody may change it under the others.
    deepFreeze(body);
    deepFreeze(links);
    const issues =
      body === null || version.deleted ? null : await contentIssues(version.collection, body, links);
    const failing = verdict.verified && stands.ok ? await checksOf(version) : NO_CHECKS;
    const reason = !verdict.verified
      ? verdict.reason
      : !stands.ok
        ? stands.reason
        : 'passes' in failing && failing.passes === false
          ? `It fails its checks: ${failing.reason}`
          : undefined;
    return Object.freeze({
      key: version.key,
      version: version.id,
      seq: version.seq,
      space: space.id,
      collection: version.collection,
      author: version.author,
      root: verdict.root,
      createdBy: creator?.verified ? creator.root : null,
      createdAt: genesis?.createdAt ?? version.createdAt,
      updatedAt: version.createdAt,
      // The caller names the body's type; nothing here checks it against one.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the caller's type for the body
      body: body as T | null,
      links,
      encrypted,
      verified: verdict.verified && stands.ok,
      ...(!grantsBeyondRecords(version.proof, space.id, DEFINE_COMMAND)
        ? { recordsOnly: true as const }
        : {}),
      ...(reason ? { reason } : {}),
      ...(version.deleted ? { deleted: true as const } : {}),
      conforms: issues === null ? null : issues.length === 0,
      ...(issues?.length ? { issues } : {}),
    });
  }

  let linkIndexCache: Promise<Map<string, Array<{ rel: string; from: string }>>> | null = null;
  const linkIndex = () => (linkIndexCache ??= buildLinkIndex());

  async function buildLinkIndex(): Promise<Map<string, Array<{ rel: string; from: string }>>> {
    const index = new Map<string, Array<{ rel: string; from: string }>>();
    for (const version of await everyCurrent()) {
      if (version.deleted) continue;
      const { links } = await openBody(version);
      for (const link of links) {
        const list = index.get(link.to) ?? [];
        list.push({ rel: link.rel, from: version.key });
        index.set(link.to, list);
      }
    }
    return index;
  }

  async function get<T>(recordKey: string): Promise<NodeRecord<T> | null> {
    const current = await currentOf(recordKey);
    return current && !current.deleted ? view<T>(current) : null;
  }

  async function list<T>(options: ListOptions = {}): Promise<ReadonlyArray<NodeRecord<T>>> {
    if (options.collection) use([options.collection]);
    const shown: Counted[] = [];
    for (const entry of (await counted()).values()) {
      const { collection, deleted } = entry.version;
      if (options.collection ? collection !== options.collection : collection.startsWith('sys.')) continue;
      if (deleted && !options.includeDeleted) continue;
      shown.push(entry);
    }
    shown.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.version.key.localeCompare(b.version.key),
    );
    if (options.newestFirst) shown.reverse();
    const page = options.limit === undefined ? shown : shown.slice(0, options.limit);
    const shownOf = (entry: Counted) =>
      (entry.shown ??= view(entry.version).catch((error: unknown) => {
        entry.shown = undefined;
        throw error;
      }));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the caller's type for the body, as in view
    return Promise.all(page.map((entry) => shownOf(entry) as Promise<NodeRecord<T>>));
  }

  async function linked<T>(
    recordKey: string,
    options: { rel?: string; collection?: string } = {},
  ): Promise<ReadonlyArray<NodeRecord<T>>> {
    if (options.collection) use([options.collection]);
    const pointing = (await linkIndex()).get(recordKey) ?? [];
    const keys = [
      ...new Set(pointing.filter((p) => !options.rel || p.rel === options.rel).map((p) => p.from)),
    ];
    const found: NodeRecord<T>[] = [];
    for (const from of keys) {
      const current = await currentOf(from);
      if (!current || current.deleted) continue;
      if (options.collection && current.collection !== options.collection) continue;
      found.push(await view<T>(current));
    }
    return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  }

  async function history<T>(recordKey: string): Promise<ReadonlyArray<NodeRecord<T>>> {
    // What a superseded version said is forgotten unless its writer retained it.
    const versions = (await storage.history(recordKey)).filter((version) => !isStub(version));
    return Promise.all(versions.map((version) => view<T>(version)));
  }

  return {
    currentOf,
    everyCurrent,
    view,
    get,
    list,
    linked,
    history,
    /** Records placed: only their keys are read again */
    stale(keys: Iterable<string>): void {
      for (const key of keys) staleKeys.add(key);
    },
    /** Something changed that may alter any verdict: the index is built again */
    forget(): void {
      countedIndex = null;
    },
    linksChanged(): void {
      linkIndexCache = null;
    },
  };
}

export type Index = ReturnType<typeof createIndex>;
