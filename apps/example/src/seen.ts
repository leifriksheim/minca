/**
 * What is new: records others wrote in an app since you last opened it. When you last looked is kept
 * in the account registry (`node.account.space()`), one record per space, so every device of yours
 * agrees: what you read on your phone is not new on your laptop.
 *
 * Every edit to a record leaves a stub of a few hundred bytes that is kept for good, and every device
 * holds the registry whole. So what is kept is how far you have read, the newest record you saw in
 * each app, not when you looked: opening an app with nothing new changes nothing. A look is held in
 * memory and written when you leave the app or hide the page, or after a quiet spell, in case the tab
 * is closed before either: an edit each time you read something new, not one a visit or a message.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { collection, type P2PNode, type SpaceSummary } from '@minca/core';
import { direct } from '@minca/core/schemas';
import { useAccount, useCollections, useLive, useNode } from '@minca/react';
import { namesMe, useSpaceApps, type AppEntry } from './components/apps/entries';

/** When you last looked at each app in one space, and when your devices first saw it */
interface SpaceSeen {
  /** Nothing before this is new: when one of your devices first saw the space */
  readonly since: string;
  /** Per app: when the newest record you saw in it was written */
  readonly apps: Readonly<Record<string, string>>;
}

/** What you have seen, by space; a space not in it hasn't been seen by any device of yours yet */
type Seen = ReadonlyMap<string, SpaceSeen>;

/** One record per space, in the account registry; the Minca app's own, like its theme */
const seenRecords = collection({
  name: 'minca.seen',
  title: 'Seen',
  schema: {
    type: 'object',
    properties: {
      space: { type: 'string', maxLength: 200 },
      since: { type: 'string', maxLength: 40 },
      // When each app was last open; a list, since a stored schema can't describe a map
      apps: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: { app: { type: 'string', maxLength: 200 }, at: { type: 'string', maxLength: 40 } },
          required: ['app', 'at'],
        },
      },
    },
    required: ['space', 'since', 'apps'],
  },
  rules: { onePer: ['@author', 'space'] },
});

const isLook = (value: unknown): value is { app: string; at: string } =>
  typeof value === 'object' &&
  value !== null &&
  'app' in value &&
  typeof value.app === 'string' &&
  'at' in value &&
  typeof value.at === 'string';

/** A stored record as a space's seen state, or null when it isn't one */
function spaceSeenOf(body: unknown): (SpaceSeen & { readonly space: string }) | null {
  if (typeof body !== 'object' || body === null) return null;
  if (!('space' in body && typeof body.space === 'string')) return null;
  if (!('since' in body && typeof body.since === 'string')) return null;
  if (!('apps' in body && Array.isArray(body.apps))) return null;
  const looks = body.apps.filter(isLook);
  return { space: body.space, since: body.since, apps: Object.fromEntries(looks.map((l) => [l.app, l.at])) };
}

/** The later of two times for each app: a record from another device never takes back a look made here */
function merged(a: SpaceSeen, b: SpaceSeen): SpaceSeen {
  const apps: Record<string, string> = { ...a.apps };
  for (const [app, at] of Object.entries(b.apps)) if (!apps[app] || at > apps[app]) apps[app] = at;
  return { since: a.since < b.since ? a.since : b.since, apps };
}

/**
 * The seen state of one node's account: read from the registry and kept current as it changes on
 * other devices, with looks made here held until they are written. Without a registry, an app given
 * only some spaces, it lives in memory alone.
 */
function createSeenStore(node: P2PNode) {
  let seen: Seen = new Map();
  /** Whether the registry was read: no space begins before it is, or it would start over */
  let loaded = false;
  /** Spaces looked at here since they were last written */
  const unwritten = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = (next: Seen) => {
    seen = next;
    for (const listener of listeners) listener();
  };

  const load = async () => {
    const registry = await node.account.space();
    const found = new Map<string, SpaceSeen>();
    if (registry) {
      const { records } = await node.records.query(registry, { collection: seenRecords });
      for (const record of records) {
        const one = spaceSeenOf(record.body);
        if (one) found.set(one.space, one);
      }
    }
    const next = new Map(seen);
    /** Spaces whose record lost reads this device made, when two devices wrote at once */
    const lost: string[] = [];
    for (const [space, one] of found) {
      const here = next.get(space);
      const both = here ? merged(one, here) : one;
      next.set(space, both);
      if (!unwritten.has(space) && JSON.stringify(both) !== JSON.stringify(one)) lost.push(space);
    }
    loaded = true;
    changed(next);
    // Written back, so every device ends up with the reads of both.
    for (const space of lost) {
      unwritten.add(space);
      keep(space);
    }
  };

  const write = async (space: string) => {
    const one = seen.get(space);
    const registry = await node.account.space();
    if (!one || !registry) return;
    unwritten.delete(space);
    const body = {
      space,
      since: one.since,
      apps: Object.entries(one.apps).map(([app, at]) => ({ app, at })),
    };
    if (!(await node.collections.list(registry)).some((c) => c.name === seenRecords.name && c.schema))
      await node.collections.define(registry, seenRecords);
    // One record per space: the first look writes it, every one after edits it.
    const key = await node.records.onePerKey(registry, seenRecords.name, body);
    if (key && (await node.records.get(registry, key))) await node.records.update(registry, key, body);
    else await node.records.put(registry, seenRecords.name, body);
  };
  // One write at a time, so two looks in quick succession don't both create the space's record.
  let writing = Promise.resolve();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const keep = (space: string) => {
    clearTimeout(timers.get(space));
    timers.delete(space);
    if (!unwritten.has(space)) return;
    writing = writing.then(() => write(space)).catch((error: unknown) => console.warn('seen:', error));
  };

  void load().catch((error: unknown) => console.warn('seen:', error));
  node.subscribe((event) => {
    if (event.type === 'account') void load().catch(() => {});
  });

  return {
    read: () => seen,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** An app in a space was read up to a record written at `upTo`: held here until `keep` */
    look(space: string, app: string, upTo: string) {
      const now = new Date().toISOString();
      // A writer dates its own records: one from the future would hide everything after it.
      const at = upTo > now ? now : upTo;
      const one = seen.get(space) ?? { since: now, apps: {} };
      if (!at || at <= (one.apps[app] ?? one.since)) return;
      changed(new Map(seen).set(space, { ...one, apps: { ...one.apps, [app]: at } }));
      unwritten.add(space);
      clearTimeout(timers.get(space));
      timers.set(
        space,
        setTimeout(() => keep(space), QUIET_MS),
      );
    },
    /** A space none of your devices has seen yet starts now: what came before is not new */
    begin(space: string) {
      if (!loaded || seen.has(space)) return;
      changed(new Map(seen).set(space, { since: new Date().toISOString(), apps: {} }));
      unwritten.add(space);
      keep(space);
    },
    keep,
  };
}

/** How far ahead a writer's clock may run before a record dated so waits for its time */
const AHEAD_MS = 5 * 60 * 1000;

/** How long looking goes on with nothing new before it is written anyway */
const QUIET_MS = 10_000;

const stores = new WeakMap<P2PNode, ReturnType<typeof createSeenStore>>();

function useSeenStore() {
  const node = useNode();
  let store = stores.get(node);
  if (!store) {
    store = createSeenStore(node);
    stores.set(node, store);
  }
  return store;
}

/**
 * Keeps an app in a space read while it is open and the page is shown, up to its newest record
 * (`upTo`, a time), so what arrives meanwhile counts as seen. Written when you leave the app or hide
 * the page.
 */
export function useLookingAt(space: string, app: string | undefined, upTo: string): void {
  const store = useSeenStore();
  useEffect(() => {
    if (!app) return;
    const look = () => {
      if (globalThis.document.visibilityState === 'visible') store.look(space, app, upTo);
      else store.keep(space);
    };
    look();
    globalThis.document.addEventListener('visibilitychange', look);
    return () => {
      globalThis.document.removeEventListener('visibilitychange', look);
      store.keep(space);
    };
  }, [store, space, app, upTo]);
}

/** How far an app in a space was read, in ms; while that isn't known yet, nothing is new */
export const seenAt = (seen: Seen, space: string, app: string): number => {
  const one = seen.get(space);
  return one ? Date.parse(one.apps[app] ?? one.since) : Number.POSITIVE_INFINITY;
};

/** What you have seen, across your devices */
export function useSeen(): Seen {
  const store = useSeenStore();
  return useSyncExternalStore(store.subscribe, store.read);
}

/** Starts a space's seen state the first time any device of yours shows it */
export function useBegin(space: string): void {
  const store = useSeenStore();
  const seen = useSeen();
  const known = seen.has(space);
  useEffect(() => {
    if (!known) store.begin(space);
  }, [store, space, known, seen]);
}

/** What is new in an app: everything, and how much of it names you — a mention, a reply */
export interface Unread {
  readonly count: number;
  readonly forMe: number;
  /** When its newest record, of anyone's, was written: how far opening it reads; empty with none */
  readonly newest: string;
}

const NONE: Unread = { count: 0, forMe: 0, newest: '' };

/** The later of two times, as ISO strings; empty is earliest */
export const later = (a: string, b: string): string => (a > b ? a : b);

/** What is new in each app in a space, by app id */
export function useUnread(spaceId: string, apps: ReadonlyArray<AppEntry>): ReadonlyMap<string, Unread> {
  const { did } = useAccount();
  const seen = useSeen();
  useBegin(spaceId);
  const watch = apps.map((app) => ({
    id: app.id,
    notify: app.notify,
    collections: [...new Set(app.notify.map((n) => n.when.query.collection))],
    after: seenAt(seen, spaceId, app.id),
  }));
  const signature = JSON.stringify(watch);
  const counts = useLive(
    spaceId,
    async (node) => {
      const out = new Map<string, Unread>();
      for (const app of watch) {
        let count = 0;
        let forMe = 0;
        let newest = '';
        // A writer dates its own records: one dated ahead would be new for good, so it waits for its time.
        const latest = new Date(Date.now() + AHEAD_MS).toISOString();
        for (const collection of app.collections) {
          const records = await node.records
            .list(spaceId, { collection, newestFirst: true, limit: 100 })
            .catch(() => []);
          for (const record of records) {
            if (record.createdAt > latest) continue;
            newest = later(newest, record.createdAt);
            if (record.createdBy === did || Date.parse(record.createdAt) <= app.after) continue;
            // Everyone sees that a direct message was written; only those it is for have something new.
            if (collection === direct.name && !sentTo(record.body, did)) continue;
            count++;
            if (namesMe(app.notify, collection, record, did)) forMe++;
          }
        }
        out.set(app.id, { count, forMe, newest });
      }
      return out;
    },
    [signature, did],
  );
  return counts ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, Unread> = new Map();

/** Whether a direct message's body names this account among those it is for */
const sentTo = (body: unknown, did: string): boolean =>
  typeof body === 'object' &&
  body !== null &&
  'to' in body &&
  Array.isArray(body.to) &&
  body.to.includes(did);

/** What is new in one app, or nothing */
export const unreadOf = (unread: ReadonlyMap<string, Unread>, id: string): Unread => unread.get(id) ?? NONE;

/** Everything new across some apps */
export function totalOf(unread: Iterable<Unread>): Unread {
  let count = 0;
  let forMe = 0;
  let newest = '';
  for (const one of unread) {
    count += one.count;
    forMe += one.forMe;
    newest = later(newest, one.newest);
  }
  return { count, forMe, newest };
}

/** Everything new in a space, across its apps: for the list of spaces */
export function useSpaceUnread(space: SpaceSummary): Unread {
  const collections = useCollections(space.id);
  const { ready } = useSpaceApps(space, collections);
  return totalOf(useUnread(space.id, ready).values());
}
