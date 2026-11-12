/**
 * What is new: records others wrote in an app since you last opened it here. How far you have read
 * is kept in this browser (`seen-store.ts`), not synced: what you read on your phone is still new on
 * your laptop.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { SpaceSummary } from '@minca/core';
import { createSeenStore, type Seen } from './seen-store';
import { direct } from '@minca/core/schemas';
import { useAccount, useCollections, useLive, useNode } from '@minca/react';
import { namesMe, useSpaceApps, type AppEntry } from './components/apps/entries';

/** How far ahead a writer's clock may run before a record dated so waits for its time */
const AHEAD_MS = 5 * 60 * 1000;

const stores = new Map<string, ReturnType<typeof createSeenStore>>();

function useSeenStore() {
  const { did } = useNode();
  let store = stores.get(did);
  if (!store) {
    store = createSeenStore(did);
    stores.set(did, store);
  }
  return store;
}

/**
 * Keeps an app in a space read while it is open and the page is shown, up to its newest record
 * (`upTo`, a time), so what arrives meanwhile counts as seen.
 */
export function useLookingAt(space: string, app: string | undefined, upTo: string): void {
  const store = useSeenStore();
  useEffect(() => {
    if (!app) return;
    const look = () => {
      if (globalThis.document.visibilityState === 'visible') store.look(space, app, upTo);
    };
    look();
    globalThis.document.addEventListener('visibilitychange', look);
    return () => globalThis.document.removeEventListener('visibilitychange', look);
  }, [store, space, app, upTo]);
}

/** How far an app in a space was read, in ms; while that isn't known yet, nothing is new */
export const seenAt = (seen: Seen, space: string, app: string): number => {
  const one = seen.get(space);
  return one ? Date.parse(one.apps[app] ?? one.since) : Number.POSITIVE_INFINITY;
};

/** What you have seen in this browser */
export function useSeen(): Seen {
  const store = useSeenStore();
  return useSyncExternalStore(store.subscribe, store.read);
}

/** Starts a space's seen state the first time this browser shows it */
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
