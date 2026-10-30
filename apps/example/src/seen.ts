/** What is new: records others wrote in an app since you last opened it, tracked in this browser only. */
import { useEffect } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAccount, useCollections, useLive } from '@minca/react';
import { accountStore } from './kept';
import { namesMe, useSpaceApps, type AppEntry } from './components/apps/entries';

interface Seen {
  /** When this browser started keeping track */
  readonly since: string;
  /** Per space, per app: when it was last open */
  readonly at: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function isSeen(value: unknown): value is Seen {
  return (
    typeof value === 'object' &&
    value !== null &&
    'since' in value &&
    typeof value.since === 'string' &&
    'at' in value &&
    typeof value.at === 'object' &&
    value.at !== null
  );
}

// With nothing kept, or storage off, it starts from now.
const kept = accountStore<Seen>(
  'minca.seen',
  (stored) => (isSeen(stored) ? stored : null),
  () => ({ since: new Date().toISOString(), at: {} }),
);

/** Marks an app in a space as looked at, now */
function markSeen(did: string, space: string, app: string): void {
  const seen = kept.read(did);
  kept.write(did, {
    since: seen.since,
    at: { ...seen.at, [space]: { ...seen.at[space], [app]: new Date().toISOString() } },
  });
}

/**
 * Keeps an app in a space looked at while it is open and the page is shown,
 * so what arrives meanwhile counts as seen; `arrived` changes when it does.
 */
export function useLookingAt(space: string, app: string | undefined, arrived: number): void {
  const { did } = useAccount();
  useEffect(() => {
    if (!app) return;
    const look = () => {
      if (globalThis.document.visibilityState === 'visible') markSeen(did, space, app);
    };
    look();
    globalThis.document.addEventListener('visibilitychange', look);
    return () => globalThis.document.removeEventListener('visibilitychange', look);
  }, [did, space, app, arrived]);
}

/** When an app in a space was last looked at, or when this browser started keeping track */
export const seenAt = (seen: Seen, space: string, app: string): string => seen.at[space]?.[app] ?? seen.since;

/** What this browser has seen, for the account */
export function useSeen(): Seen {
  return kept.use(useAccount().did);
}

/** What is new in an app: everything, and how much of it names you — a mention, a reply */
export interface Unread {
  readonly count: number;
  readonly forMe: number;
}

const NONE: Unread = { count: 0, forMe: 0 };

/** What is new in each app in a space, by app id */
export function useUnread(spaceId: string, apps: ReadonlyArray<AppEntry>): ReadonlyMap<string, Unread> {
  const { did } = useAccount();
  const seen = useSeen();
  const watch = apps.map((app) => ({
    id: app.id,
    notify: app.notify,
    collections: [...new Set(app.notify.map((n) => n.when.query.collection))],
    after: Date.parse(seenAt(seen, spaceId, app.id)),
  }));
  const signature = JSON.stringify(watch);
  const counts = useLive(
    spaceId,
    async (node) => {
      const out = new Map<string, Unread>();
      for (const app of watch) {
        let count = 0;
        let forMe = 0;
        for (const collection of app.collections) {
          const records = await node.records
            .list(spaceId, { collection, newestFirst: true, limit: 100 })
            .catch(() => []);
          for (const record of records) {
            if (record.createdBy === did || Date.parse(record.createdAt) <= app.after) continue;
            count++;
            if (namesMe(app.notify, collection, record, did)) forMe++;
          }
        }
        out.set(app.id, { count, forMe });
      }
      return out;
    },
    [signature, did],
  );
  return counts ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, Unread> = new Map();

/** What is new in one app, or nothing */
export const unreadOf = (unread: ReadonlyMap<string, Unread>, id: string): Unread => unread.get(id) ?? NONE;

/** Everything new across some apps */
export function totalOf(unread: Iterable<Unread>): Unread {
  let count = 0;
  let forMe = 0;
  for (const one of unread) {
    count += one.count;
    forMe += one.forMe;
  }
  return { count, forMe };
}

/** Everything new in a space, across its apps: for the list of spaces */
export function useSpaceUnread(space: SpaceSummary): Unread {
  const collections = useCollections(space.id);
  const { ready } = useSpaceApps(space, collections);
  return totalOf(useUnread(space.id, ready).values());
}
