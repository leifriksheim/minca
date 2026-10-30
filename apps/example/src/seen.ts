/** What is new: records others wrote in a tool since you last opened it, tracked in this browser only. */
import { useEffect } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAccount, useCollections, useLive } from '@minca/react';
import { accountStore } from './kept';
import { namesMe, useSpaceTools, type ToolEntry } from './components/tools/entries';

interface Seen {
  /** When this browser started keeping track */
  readonly since: string;
  /** Per space, per tool: when it was last open */
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

/** Marks a tool in a space as looked at, now */
function markSeen(did: string, space: string, tool: string): void {
  const seen = kept.read(did);
  kept.write(did, {
    since: seen.since,
    at: { ...seen.at, [space]: { ...seen.at[space], [tool]: new Date().toISOString() } },
  });
}

/**
 * Keeps a tool in a space looked at while it is open and the page is shown,
 * so what arrives meanwhile counts as seen; `arrived` changes when it does.
 */
export function useLookingAt(space: string, tool: string | undefined, arrived: number): void {
  const { did } = useAccount();
  useEffect(() => {
    if (!tool) return;
    const look = () => {
      if (globalThis.document.visibilityState === 'visible') markSeen(did, space, tool);
    };
    look();
    globalThis.document.addEventListener('visibilitychange', look);
    return () => globalThis.document.removeEventListener('visibilitychange', look);
  }, [did, space, tool, arrived]);
}

/** When a tool in a space was last looked at, or when this browser started keeping track */
export const seenAt = (seen: Seen, space: string, tool: string): string =>
  seen.at[space]?.[tool] ?? seen.since;

/** What this browser has seen, for the account */
export function useSeen(): Seen {
  return kept.use(useAccount().did);
}

/** What is new in a tool: everything, and how much of it names you — a mention, a reply */
export interface Unread {
  readonly count: number;
  readonly forMe: number;
}

const NONE: Unread = { count: 0, forMe: 0 };

/** What is new in each tool in a space, by tool id */
export function useUnread(spaceId: string, tools: ReadonlyArray<ToolEntry>): ReadonlyMap<string, Unread> {
  const { did } = useAccount();
  const seen = useSeen();
  const watch = tools.map((tool) => ({
    id: tool.id,
    notify: tool.notify,
    collections: [...new Set(tool.notify.map((n) => n.when.query.collection))],
    after: Date.parse(seenAt(seen, spaceId, tool.id)),
  }));
  const signature = JSON.stringify(watch);
  const counts = useLive(
    spaceId,
    async (node) => {
      const out = new Map<string, Unread>();
      for (const tool of watch) {
        let count = 0;
        let forMe = 0;
        for (const collection of tool.collections) {
          const records = await node.records
            .list(spaceId, { collection, newestFirst: true, limit: 100 })
            .catch(() => []);
          for (const record of records) {
            if (record.createdBy === did || Date.parse(record.createdAt) <= tool.after) continue;
            count++;
            if (namesMe(tool.notify, collection, record, did)) forMe++;
          }
        }
        out.set(tool.id, { count, forMe });
      }
      return out;
    },
    [signature, did],
  );
  return counts ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, Unread> = new Map();

/** What is new in one tool, or nothing */
export const unreadOf = (unread: ReadonlyMap<string, Unread>, id: string): Unread => unread.get(id) ?? NONE;

/** Everything new across some tools */
export function totalOf(unread: Iterable<Unread>): Unread {
  let count = 0;
  let forMe = 0;
  for (const one of unread) {
    count += one.count;
    forMe += one.forMe;
  }
  return { count, forMe };
}

/** Everything new in a space, across its tools: for the list of spaces */
export function useSpaceUnread(space: SpaceSummary): Unread {
  const collections = useCollections(space.id);
  const { ready } = useSpaceTools(space, collections);
  return totalOf(useUnread(space.id, ready).values());
}
