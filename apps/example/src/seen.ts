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
import type { P2PNode, SpaceSummary } from '@minca/core';
import { createSeenStore, type Seen } from './seen-store';
import { direct } from '@minca/core/schemas';
import { useAccount, useCollections, useLive, useNode } from '@minca/react';
import { namesMe, useSpaceApps, type AppEntry } from './components/apps/entries';

/** How far ahead a writer's clock may run before a record dated so waits for its time */
const AHEAD_MS = 5 * 60 * 1000;

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
