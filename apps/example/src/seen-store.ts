/**
 * How far this browser has read each app in each space of one account: what `seen.ts` shows as new.
 * Apart from the hooks so it runs, and is tested, without React.
 */
import { readKept, writeKept } from './kept';

/** When you last looked at each app in one space, and when this browser first saw it */
export interface SpaceSeen {
  /** Nothing before this is new: when this browser first saw the space */
  readonly since: string;
  /** Per app: when the newest record you saw in it was written */
  readonly apps: Readonly<Record<string, string>>;
}

/** What you have seen, by space; a space not in it hasn't been seen here yet */
export type Seen = ReadonlyMap<string, SpaceSeen>;

const isSpaceSeen = (value: unknown): value is SpaceSeen =>
  typeof value === 'object' &&
  value !== null &&
  'since' in value &&
  typeof value.since === 'string' &&
  'apps' in value &&
  typeof value.apps === 'object' &&
  value.apps !== null &&
  Object.values(value.apps).every((at) => typeof at === 'string');

function readSeen(keptUnder: string): Seen {
  const kept = readKept(keptUnder);
  if (typeof kept !== 'object' || kept === null) return new Map();
  return new Map(Object.entries(kept).filter((entry): entry is [string, SpaceSeen] => isSpaceSeen(entry[1])));
}

/** The seen state of one account in this browser, shared by its tabs */
export function createSeenStore(accountDid: string) {
  const keptUnder = `minca.seen:${accountDid}`;
  let seen = readSeen(keptUnder);
  const listeners = new Set<() => void>();
  const changed = (next: Seen) => {
    seen = next;
    for (const listener of listeners) listener();
  };
  const keep = (next: Seen) => {
    writeKept(keptUnder, Object.fromEntries(next));
    changed(next);
  };
  globalThis.addEventListener?.('storage', (event: StorageEvent) => {
    if (event.key === keptUnder) changed(readSeen(keptUnder));
  });

  return {
    read: () => seen,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** An app in a space was read up to a record written at `upTo` */
    look(space: string, app: string, upTo: string) {
      const now = new Date().toISOString();
      // A writer dates its own records: one from the future would hide everything after it.
      const at = upTo > now ? now : upTo;
      const one = seen.get(space) ?? { since: now, apps: {} };
      if (!at || at <= (one.apps[app] ?? one.since)) return;
      keep(new Map(seen).set(space, { ...one, apps: { ...one.apps, [app]: at } }));
    },
    /** A space this browser hasn't seen yet starts now: what came before is not new */
    begin(space: string) {
      if (seen.has(space)) return;
      keep(new Map(seen).set(space, { since: new Date().toISOString(), apps: {} }));
    },
  };
}
