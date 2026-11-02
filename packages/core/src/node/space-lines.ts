/**
 * @module node/space-lines
 * Writers' logs. A key's writes in each collection here form one line
 * (02 §4.10). Each place a key took is remembered by the version that took
 * it, so a second version at the same place is found the moment it arrives.
 * And each version is checked against the one it names as the place before —
 * when it arrives, or when that one does. Either way the proof goes to
 * everyone else. A change taking power from an account leaves standing what
 * its lines hold (its cutoff).
 */
import type { StorageAdapter, Version } from '../types.js';
import { accessRequirement, noteGrants } from '../identity/abilities.js';
import { breaksLine, forkProof } from '../records/fork.js';
import { forkKey } from '../space/space-access.js';
import { FORK_COLLECTION } from '../space/roles.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import type { Versions, SpaceBase } from './space-versions.js';
import { type History, MAX_CUTOFF } from './space-history.js';
import type { Catalog } from './space-catalog.js';

/** A change's body, with its cutoff when that covers anything */
export const withCutoff = <T extends object>(body: T, cutoff: Record<string, Record<string, number>>) =>
  Object.keys(cutoff).length ? { ...body, cutoff } : body;

/** Orders text by code unit, as `<` does */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface LinesDeps extends SpaceBase {
  readonly adapter: StorageAdapter;
  readonly versions: Versions;
  readonly history: History;
  readonly catalog: Catalog;
  readonly everyCurrent: () => Promise<Version[]>;
  /** A gap in a line this node holds part of (`node/space-holding.ts`) */
  readonly noteGap: (version: Version) => Promise<void>;
  readonly upsert: (collection: string, recordKey: string, body: unknown) => Promise<unknown>;
  readonly cannotWrite: () => Promise<string | null>;
}

export function createLines(deps: LinesDeps) {
  const { space, session, adapter, storage, everyCurrent, noteGap, upsert, cannotWrite } = deps;
  const { judge } = deps.versions;
  const { access } = deps.history;
  const { catalog } = deps.catalog;

  // Named for this format of the log: the `log/`, `next/`, `clog/` and
  // `cnext/` a node kept before it map places to versions no peer holds any
  // more, so they are left unread rather than trusted.
  /** `place/<author>/<collection>/<n>` → the id of the version that took that place */
  const LOG_PREFIX = 'place/';
  /** Key DID → the account it writes for here */
  const KEY_ROOT_PREFIX = 'keyroot/';
  /** `follows/<id>` → the id of a version naming that one as the place before it */
  const NEXT_PREFIX = 'follows/';

  async function placeInLog(version: Version): Promise<void> {
    if (version.space !== space.id || !version.log) return;
    const { log } = version;
    // Which account each key writes for: what a cutoff is worked out from.
    const root = (await judge(version)).root;
    // Only an account a valid note names: a key whose note failed falls back to itself, and isn't anyone's.
    if (
      root &&
      (root !== version.author || !version.proof) &&
      !(await adapter.get(`${KEY_ROOT_PREFIX}${version.author}`))
    )
      await adapter.put(`${KEY_ROOT_PREFIX}${version.author}`, utf8Encode(root));
    // Its place: a second version there is a fork.
    const at = `${LOG_PREFIX}${version.author}/${version.collection}/${log.n}`;
    const held = await adapter.get(at);
    if (!held) await adapter.put(at, utf8Encode(version.id));
    else if (utf8Decode(held) !== version.id) {
      const first = await storage.getVersion(utf8Decode(held));
      if (first) void reportFork(first, version, version.author, version.collection, log.n).catch(() => {});
    }
    // The place before it, if held, must be its key's; and so must it be for whatever names it.
    if (log.prev) {
      await adapter.put(`${NEXT_PREFIX}${log.prev}`, utf8Encode(version.id));
      const previous = await storage.getVersion(log.prev);
      if (previous && breaksLine(version, previous))
        void reportFork(version, previous, version.author, version.collection, log.n).catch(() => {});
    }
    const naming = await adapter.get(`${NEXT_PREFIX}${version.id}`);
    const next = naming ? await storage.getVersion(utf8Decode(naming)) : null;
    if (next?.log && breaksLine(next, version))
      void reportFork(next, version, next.author, next.collection, next.log.n).catch(() => {});
    await noteGap(version);
  }

  /**
   * Hands every peer the proof that a key's line for a collection is not one
   * line — a fork or a break — unless a proof at or before this place stands
   * already. Any member may; one whose note doesn't let it change access
   * leaves it to one whose note does.
   */
  async function reportFork(
    a: Version,
    b: Version,
    writer: string,
    collection: string,
    from: number,
  ): Promise<void> {
    if (deps.isClosed()) return;
    const known = (await access()).history.forked(writer, collection);
    if (known && known.from <= from) return;
    if (
      !noteGrants(session.proof(), accessRequirement(space.id, FORK_COLLECTION, await forkKey(writer))) ||
      (await cannotWrite())
    )
      return;
    await upsert(FORK_COLLECTION, await forkKey(writer), forkProof(a, b));
  }

  /**
   * What a change taking power from an account leaves standing: for each of
   * its keys and each collection, the end of the unbroken line this node
   * holds of that key's versions in that collection, from its first place,
   * each naming the one before. A place held past a gap covers nothing, so
   * one planted far ahead can't cover what its writer signs after; and a node
   * holding some collections keeps their lines whole (05 §9), so it covers
   * all it holds.
   */
  async function cutoffFor(did: string, only?: string): Promise<Record<string, Record<string, number>>> {
    const cutoff: Record<string, Record<string, number>> = {};
    // At most what a change may carry: what is left out is judged with the change.
    for (const end of (await linesOf(did, only)).slice(0, MAX_CUTOFF))
      (cutoff[end.author] ??= {})[end.collection] = end.log!.n;
    return cutoff;
  }

  /**
   * The ends of an account's unbroken lines this node holds: defined
   * collections first, then the rest, each in name order.
   */
  async function linesOf(did: string, only?: string): Promise<Version[]> {
    // What it holds of theirs, whatever way it came: the lines' places are kept only for what arrived by sync.
    const placed = new Map<string, Map<number, Version>>();
    const add = (version: Version) => {
      if (!version.log) return;
      const line = `${version.author} ${version.collection}`;
      const held = placed.get(line) ?? new Map<number, Version>();
      if (!held.has(version.log.n)) held.set(version.log.n, version);
      placed.set(line, held);
    };
    for (const version of await everyCurrent()) {
      if (!version.log || (only && version.author !== only) || version.space !== space.id) continue;
      if ((await judge(version)).root === did) add(version);
    }
    for (const name of await adapter.list(KEY_ROOT_PREFIX)) {
      const key = name.slice(KEY_ROOT_PREFIX.length);
      if ((only && key !== only) || utf8Decode((await adapter.get(name)) ?? new Uint8Array()) !== did)
        continue;
      for (const place of await adapter.list(`${LOG_PREFIX}${key}/`)) {
        const id = await adapter.get(place);
        const version = id ? await storage.getVersion(utf8Decode(id)) : null;
        if (version?.author === key) add(version);
      }
    }
    const ends: Version[] = [];
    for (const held of placed.values()) {
      let end: Version | null = null;
      for (let n = 0; ; n++) {
        const version = held.get(n);
        if (!version || (n > 0 && version.log?.prev !== end?.id)) break;
        end = version;
      }
      if (end) ends.push(end);
    }
    // Defined collections first: writing into many undefined ones costs only whoever did.
    const defined = new Set((await catalog()).keys());
    return ends.sort(
      (a, b) =>
        Number(defined.has(b.collection)) - Number(defined.has(a.collection)) ||
        byCodeUnit(a.collection, b.collection) ||
        byCodeUnit(a.author, b.author),
    );
  }

  return { placeInLog, cutoffFor };
}

export type Lines = ReturnType<typeof createLines>;
